// ==========================================
// ระบบรวมศูนย์ CM Party:
// - LINE Bot Webhook (ต้อนรับเพื่อนใหม่, อัปโหลดรูปลง Google Drive, พิมพ์ "ตรวจสอบรางวัล" ค้นหาจาก Sheet gift)
// - ระบบลงทะเบียนเข้างานเลี้ยง (index.html -> Sheet "Register")
// - ระบบบันทึกและจัดการรางวัล (reward.html -> Sheet "gift" + LINE Push Flex Message)
// ==========================================
// อ่าน LINE_BOT_ACCESS_TOKEN จาก Script Properties (เพื่อไม่ให้เก็บ Token จริงไว้ในโค้ด/GitHub)
function getLineBotAccessToken() {
  const token = String(PropertiesService.getScriptProperties().getProperty('LINE_BOT_ACCESS_TOKEN') || '').trim();
  if (!token) {
    console.error('Missing Script Property: LINE_BOT_ACCESS_TOKEN');
  }
  return token;
}

const EXTRA_ADMIN_UIDS_PROP_KEY = 'EXTRA_ADMIN_UIDS';
const LINE_LIFF_CHANNEL_ID = '2012486224';

function sha256ShortKey(rawStr) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(rawStr || ''),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '').slice(0, 32);
}

/**
 * ตรวจสอบความถูกต้องของ LINE LIFF Token (ID Token หรือ Access Token) กับ LINE OAuth2 Verify API
 * ใช้ร่วมกับ CacheService (ไม่เกิน 5 นาที) เพื่อความรวดเร็วและป้องกันการปลอมแปลง adminUid / uid
 */
function verifyLineUserFromPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { verified: false, uid: '' };
  }

  const idToken = String(payload.lineIdToken || payload.idToken || '').trim();
  const accessToken = String(payload.lineAccessToken || payload.accessToken || '').trim();
  const cache = CacheService.getScriptCache();

  // 1. ตรวจสอบ ID Token (1 HTTP call หาก LIFF เปิด scope openid)
  if (idToken) {
    const idCacheKey = 'LINE_IDT_' + sha256ShortKey(idToken);
    try {
      const cachedUid = cache.get(idCacheKey);
      if (cachedUid && /^U[a-zA-Z0-9]+$/.test(cachedUid)) {
        return { verified: true, uid: cachedUid, method: 'id_token_cache' };
      }
    } catch (cErr) {}

    try {
      const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'post',
        payload: {
          id_token: idToken,
          client_id: LINE_LIFF_CHANNEL_ID
        },
        muteHttpExceptions: true
      });
      if (res.getResponseCode() === 200) {
        const json = JSON.parse(res.getContentText() || '{}');
        const sub = String(json.sub || '').trim();
        const expSec = Number(json.exp || 0);
        const remSec = expSec > 0 ? Math.floor(expSec - (Date.now() / 1000)) - 5 : 300;
        if (String(json.aud || '') === LINE_LIFF_CHANNEL_ID && /^U[a-zA-Z0-9]+$/.test(sub) && remSec > 0) {
          try {
            cache.put(idCacheKey, sub, Math.min(300, Math.max(10, remSec)));
          } catch (putErr) {}
          return { verified: true, uid: sub, method: 'id_token' };
        }
      }
    } catch (idErr) {}
  }

  // 2. ตรวจสอบ Access Token (รองรับทุก LIFF ที่มี scope profile)
  if (accessToken) {
    const atCacheKey = 'LINE_AT_' + sha256ShortKey(accessToken);
    try {
      const cachedAtUid = cache.get(atCacheKey);
      if (cachedAtUid && /^U[a-zA-Z0-9]+$/.test(cachedAtUid)) {
        return { verified: true, uid: cachedAtUid, method: 'access_token_cache' };
      }
    } catch (cErr) {}

    try {
      const verifyRes = UrlFetchApp.fetch(
        'https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(accessToken),
        { method: 'get', muteHttpExceptions: true }
      );
      if (verifyRes.getResponseCode() === 200) {
        const vJson = JSON.parse(verifyRes.getContentText() || '{}');
        const expiresIn = Number(vJson.expires_in || 0);
        if (String(vJson.client_id || '') === LINE_LIFF_CHANNEL_ID && expiresIn > 0) {
          const profileRes = UrlFetchApp.fetch('https://api.line.me/v2/profile', {
            method: 'get',
            headers: {
              'Authorization': 'Bearer ' + accessToken
            },
            muteHttpExceptions: true
          });
          if (profileRes.getResponseCode() === 200) {
            const pJson = JSON.parse(profileRes.getContentText() || '{}');
            const verifiedUid = String(pJson.userId || '').trim();
            if (/^U[a-zA-Z0-9]+$/.test(verifiedUid)) {
              const ttl = Math.min(300, Math.max(10, Math.floor(expiresIn) - 10));
              try {
                cache.put(atCacheKey, verifiedUid, ttl);
              } catch (putErr) {}
              return { verified: true, uid: verifiedUid, method: 'access_token' };
            }
          }
        }
      }
    } catch (atErr) {}
  }

  return { verified: false, uid: '' };
}

function getExtraAdminsList() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(EXTRA_ADMIN_UIDS_PROP_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => {
        if (typeof item === 'string') {
          return { uid: item.trim(), label: item.trim(), empId: '', addedAt: '' };
        }
        return {
          uid: String((item && item.uid) || '').trim(),
          label: String((item && item.label) || (item && item.uid) || '').trim(),
          empId: String((item && item.empId) || '').trim(),
          addedAt: String((item && item.addedAt) || '').trim()
        };
      })
      .filter(a => a.uid && a.uid !== ADMIN_UID);
  } catch (e) {
    return [];
  }
}

function saveExtraAdminsList(list) {
  PropertiesService.getScriptProperties().setProperty(EXTRA_ADMIN_UIDS_PROP_KEY, JSON.stringify(list || []));
}

function isAdminUid(uid) {
  const cleanUid = String(uid || '').trim();
  if (!cleanUid) return false;
  if (cleanUid === ADMIN_UID) return true;
  return getExtraAdminsList().some(a => a.uid === cleanUid);
}

function getVerifiedAdminUid(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const auth = verifyLineUserFromPayload(payload);
  if (auth && auth.verified && isAdminUid(auth.uid)) {
    return auth.uid;
  }
  return '';
}

function isAdminAuthorized(payload) {
  return Boolean(getVerifiedAdminUid(payload));
}

function getAdminManagementList(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'forbidden', message: 'ไม่มีสิทธิ์เข้าถึงรายชื่อแอดมิน (เฉพาะแอดมินเท่านั้น)' };
  }
  return {
    status: 'success',
    superAdminUid: ADMIN_UID,
    admins: getExtraAdminsList()
  };
}

function addExtraAdmin(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'forbidden', message: 'ไม่มีสิทธิ์เพิ่มแอดมิน (เฉพาะแอดมินเท่านั้น)' };
  }
  const inputVal = String((payload && (payload.targetInput || payload.targetUid || payload.empId)) || '').trim();
  if (!inputVal) {
    return { status: 'error', message: 'กรุณาระบุรหัสพนักงาน หรือ LINE UID' };
  }

  let targetUid = '';
  let label = '';
  let empId = '';

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const { employeesMap } = getRegisteredEmployeesFromRegisterSheet(ss);

  if (/^U[a-zA-Z0-9]{15,}$/.test(inputVal)) {
    targetUid = inputVal;
    const allEmps = Object.keys(employeesMap).map(k => employeesMap[k]);
    const matchedByUid = allEmps.find(e => e && e.uid === targetUid);
    if (matchedByUid) {
      empId = matchedByUid.empId || '';
      label = matchedByUid.empName || matchedByUid.displayName || targetUid;
    } else {
      label = String(payload.label || targetUid).trim();
    }
  } else {
    const cleanId = inputVal.replace(/\.0$/, '');
    const matchedEmp = employeesMap[cleanId];
    if (!matchedEmp) {
      return {
        status: 'error',
        message: `ไม่พบรหัสพนักงาน "${cleanId}" ใน Sheet Register (พนักงานต้องสแกนลงทะเบียนเข้างานก่อน หรือกรอก LINE UID โดยตรง)`
      };
    }
    if (!matchedEmp.uid || matchedEmp.uid === 'TEST_USER') {
      return {
        status: 'error',
        message: `พนักงาน "${matchedEmp.empName}" (${cleanId}) ยังไม่มี LINE UID ในระบบ (ไม่สามารถใช้สิทธิ์แอดมินผ่าน LINE ได้)`
      };
    }
    targetUid = matchedEmp.uid;
    empId = matchedEmp.empId;
    label = matchedEmp.empName || matchedEmp.displayName || cleanId;
  }

  if (targetUid === ADMIN_UID) {
    return { status: 'error', message: 'บัญชีนี้เป็นแอดมินหลัก (Super Admin) อยู่แล้ว' };
  }

  const currentList = getExtraAdminsList();
  if (currentList.some(a => a.uid === targetUid)) {
    return { status: 'error', message: `"${label}" เป็นแอดมินอยู่แล้ว` };
  }

  const nowStr = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');
  const newEntry = { uid: targetUid, label: label, empId: empId, addedAt: nowStr };
  currentList.push(newEntry);
  saveExtraAdminsList(currentList);

  return {
    status: 'success',
    message: `เพิ่ม "${label}" เป็นแอดมินเรียบร้อยแล้ว`,
    superAdminUid: ADMIN_UID,
    admins: currentList,
    addedAdmin: newEntry
  };
}

function removeExtraAdmin(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'forbidden', message: 'ไม่มีสิทธิ์ลบแอดมิน (เฉพาะแอดมินเท่านั้น)' };
  }
  const targetUid = String((payload && payload.targetUid) || '').trim();
  if (!targetUid) {
    return { status: 'error', message: 'กรุณาระบุ LINE UID ของแอดมินที่ต้องการลบ' };
  }
  if (targetUid === ADMIN_UID) {
    return { status: 'error', message: 'ไม่สามารถลบแอดมินหลัก (Super Admin) ได้' };
  }

  const currentList = getExtraAdminsList();
  const nextList = currentList.filter(a => a.uid !== targetUid);
  if (nextList.length === currentList.length) {
    return { status: 'error', message: 'ไม่พบรายชื่อแอดมินที่ต้องการลบ' };
  }
  saveExtraAdminsList(nextList);

  return {
    status: 'success',
    message: 'ลบสิทธิ์แอดมินเรียบร้อยแล้ว',
    superAdminUid: ADMIN_UID,
    admins: nextList
  };
}
const LINE_DRIVE_FOLDER_ID = '1Mob3ioDYe_67dLNHp3zQR4tGl2EtFJ-L';
const LINE_DEFAULT_FOLDER_NAME = 'LINE_Bot_Uploads';

const SPREADSHEET_ID = '1j2wb2cBiPK2IDfpNKJZBSUu3MDVwSEogAkRENvU-GJw';
const SOURCE_SHEET_NAME = 'การตอบแบบฟอร์ม 1';
const TARGET_SHEET_NAME = 'Register';
const GIFT_SHEET_NAME = 'gift';
const REWARD_SHEET_GID = 195154721;
const SHIFT_ATTEND_ANSWER_EXACT = 'ไม่ได้ไปเพราะอยู่ กะ';
const SHIFT_AUTO_REG_STATUS = 'ลงทะเบียนอัตโนมัติ (อยู่กะ)';
// แผนกที่ลงทะเบียนร่วมงานได้ แต่ไม่มีสิทธิ์รับรางวัล
const EXCLUDED_REWARD_DEPARTMENTS = ['1.บริหาร'];

function isExcludedFromRewardDepartment(department) {
  const normDept = String(department || '').replace(/\s+/g, '').trim();
  if (!normDept) return false;
  return EXCLUDED_REWARD_DEPARTMENTS.some(d => {
    const normTarget = String(d || '').replace(/\s+/g, '').trim();
    return normDept === normTarget || normDept.indexOf(normTarget) !== -1;
  });
}

// บัญชีแอดมินสำหรับจัดการเปิด-ปิดระบบลงทะเบียน
const ADMIN_UID = 'U1dcbd47c6981745c2f41c5691cde7ff3';

// ลิงก์หน้าลงทะเบียน LIFF และหน้าแกลเลอรีภาพกิจกรรม
const LIFF_REGISTER_URL = 'https://liff.line.me/2012486224-eFJTgFwr';
const GALLERY_WEB_URL = 'https://cmparty.vercel.app/gallery.html';

// คาแรกเตอร์ผู้ส่ง (LINE Icon & Nickname Switch - ความยาว <= 20 ตัวอักษร และไม่มีคำว่า "LINE")
const BOT_SENDERS = {
  elf: {
    name: 'เอลฟ์ต้อนรับ 🎄',
    iconUrl: 'https://cmparty.vercel.app/assets/sender-elf.png'
  },
  santa: {
    name: 'Santa แจกรางวัล 🎁',
    iconUrl: 'https://cmparty.vercel.app/assets/sender-santa.png'
  },
  photo: {
    name: 'ช่างภาพปาร์ตี้ 📸',
    iconUrl: 'https://cmparty.vercel.app/assets/sender-photo.png'
  }
};

function withBotSender(msgObj, senderKey) {
  const senderCfg = BOT_SENDERS[senderKey];
  if (!msgObj || !senderCfg) return msgObj;
  return {
    ...msgObj,
    sender: {
      name: senderCfg.name,
      iconUrl: senderCfg.iconUrl
    }
  };
}

/**
 * แปลง Date/Time String (เช่น "2026-12-25T09:00") เป็น Timestamp (ms) ตามเวลาประเทศไทย (UTC+7)
 */
function parseBangkokTimeMs(str) {
  if (!str) return NaN;
  const s = String(str).trim();
  if (!s) return NaN;
  if (/Z$|[+-]\d{2}:\d{2}$/.test(s)) {
    return new Date(s).getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) {
    return new Date(s + ':00+07:00').getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) {
    return new Date(s + '+07:00').getTime();
  }
  return new Date(s).getTime();
}

/**
 * ตรวจสอบสถานะการเปิด/ปิดระบบลงทะเบียน (รองรับทั้งตั้งวันเวลาเปิด, ตั้งวันเวลาปิด และเปิด/ปิดทันที)
 * คืนค่า: Object { systemStatus, isOpen, openingDateTime, isBeforeOpeningTime, closingDateTime, isPastClosingTime, manualStatus }
 */
function getRegistrationSystemStatus() {
  try {
    const props = PropertiesService.getScriptProperties();
    const manualStatus = props.getProperty('REGISTRATION_SYSTEM_STATUS') || 'OPEN';
    const openingDateTimeStr = props.getProperty('REGISTRATION_OPENING_DATETIME') || '';
    const closingDateTimeStr = props.getProperty('REGISTRATION_CLOSING_DATETIME') || '';

    const now = Date.now();

    let isBeforeOpeningTime = false;
    if (openingDateTimeStr) {
      const openingTime = parseBangkokTimeMs(openingDateTimeStr);
      if (!isNaN(openingTime) && now < openingTime) {
        isBeforeOpeningTime = true;
      }
    }

    let isPastClosingTime = false;
    if (closingDateTimeStr) {
      const closingTime = parseBangkokTimeMs(closingDateTimeStr);
      if (!isNaN(closingTime) && now >= closingTime) {
        isPastClosingTime = true;
      }
    }

    // ลำดับสถานะ:
    // 1. หากสั่ง Manual CLOSED หรือเลยกำหนดเวลาปิดแล้ว -> 'CLOSED'
    // 2. หากยังไม่ถึงเวลาเปิดที่ตั้งไว้ -> 'WAITING_OPEN'
    // 3. นอกนั้น -> 'OPEN'
    let currentStatus = 'OPEN';
    if (manualStatus === 'CLOSED' || isPastClosingTime) {
      currentStatus = 'CLOSED';
    } else if (isBeforeOpeningTime) {
      currentStatus = 'WAITING_OPEN';
    }

    const isOpen = currentStatus === 'OPEN';

    return {
      systemStatus: currentStatus,
      isOpen: isOpen,
      openingDateTime: openingDateTimeStr,
      isBeforeOpeningTime: isBeforeOpeningTime,
      closingDateTime: closingDateTimeStr,
      isPastClosingTime: isPastClosingTime,
      manualStatus: manualStatus
    };
  } catch (e) {
    console.error('Error reading REGISTRATION_SYSTEM_STATUS:', e);
    return {
      systemStatus: 'OPEN',
      isOpen: true,
      openingDateTime: '',
      isBeforeOpeningTime: false,
      closingDateTime: '',
      isPastClosingTime: false,
      manualStatus: 'OPEN'
    };
  }
}

/**
 * บันทึกการกำหนดวันเวลาเปิด-ปิดระบบ หรือเปิด/ปิดระบบลงทะเบียนทันที (เฉพาะ Admin ที่ผ่านการยืนยัน Token เท่านั้น)
 */
function setRegistrationSchedule(openingDateTime, closingDateTime, authPayloadOrUid, manualStatus) {
  if (!authPayloadOrUid || typeof authPayloadOrUid !== 'object' || !isAdminAuthorized(authPayloadOrUid)) {
    return {
      status: 'forbidden',
      message: 'ไม่มีสิทธิ์ในการเปลี่ยนการตั้งค่าระบบ (เฉพาะแอดมินเท่านั้น)'
    };
  }

  const props = PropertiesService.getScriptProperties();

  // ตรวจสอบกรณีตั้งทั้งเวลาเปิดและเวลาปิดพร้อมกัน ว่าเวลาเปิดต้องน้อยกว่าเวลาปิด
  if (openingDateTime && closingDateTime) {
    const openMs = parseBangkokTimeMs(openingDateTime);
    const closeMs = parseBangkokTimeMs(closingDateTime);
    if (!isNaN(openMs) && !isNaN(closeMs) && openMs >= closeMs) {
      return {
        status: 'error',
        message: 'วันเวลาเปิดระบบต้องมาก่อนวันเวลาปิดระบบครับ'
      };
    }
  }

  // จัดการวันเวลาเปิดระบบ (REGISTRATION_OPENING_DATETIME)
  if (openingDateTime !== null && openingDateTime !== undefined) {
    const cleanOpen = String(openingDateTime).trim();
    if (cleanOpen) {
      props.setProperty('REGISTRATION_OPENING_DATETIME', cleanOpen);
      props.setProperty('REGISTRATION_SYSTEM_STATUS', 'OPEN');
    } else {
      props.deleteProperty('REGISTRATION_OPENING_DATETIME');
    }
  }

  // จัดการวันเวลาปิดระบบ (REGISTRATION_CLOSING_DATETIME)
  if (closingDateTime !== null && closingDateTime !== undefined) {
    const cleanClose = String(closingDateTime).trim();
    if (cleanClose) {
      props.setProperty('REGISTRATION_CLOSING_DATETIME', cleanClose);
      const closeVal = parseBangkokTimeMs(cleanClose);
      if (!isNaN(closeVal) && closeVal > Date.now()) {
        props.setProperty('REGISTRATION_SYSTEM_STATUS', 'OPEN');
      }
    } else {
      props.deleteProperty('REGISTRATION_CLOSING_DATETIME');
    }
  }

  // จัดการ Manual Override ('OPEN' หรือ 'CLOSED')
  if (manualStatus) {
    const target = manualStatus === 'CLOSED' ? 'CLOSED' : 'OPEN';
    props.setProperty('REGISTRATION_SYSTEM_STATUS', target);
    // หากแอดมินกด "สั่งเปิดระบบทันที (Manual Open)" ให้ล้างเวลาเปิดที่ยังไม่ถึง หรือเวลาปิดที่ผ่านไปแล้วออก เพื่อให้เปิดได้ทันที
    if (target === 'OPEN') {
      const curOpen = props.getProperty('REGISTRATION_OPENING_DATETIME') || '';
      if (curOpen && parseBangkokTimeMs(curOpen) > Date.now()) {
        props.deleteProperty('REGISTRATION_OPENING_DATETIME');
      }
      const curClose = props.getProperty('REGISTRATION_CLOSING_DATETIME') || '';
      if (curClose && parseBangkokTimeMs(curClose) <= Date.now()) {
        props.deleteProperty('REGISTRATION_CLOSING_DATETIME');
      }
    }
  }

  const statusInfo = getRegistrationSystemStatus();
  return {
    status: 'success',
    ...statusInfo,
    message: 'บันทึกการตั้งค่าเวลาเปิด-ปิดระบบเรียบร้อยแล้ว'
  };
}

/**
 * ฟังก์ชันสำรองเพื่อความเข้ากันได้ย้อนหลัง
 */
function setRegistrationClosingDateTime(closingDateTime, requesterUid, manualStatus, openingDateTime) {
  return setRegistrationSchedule(openingDateTime, closingDateTime, requesterUid, manualStatus);
}

/**
 * สลับ/ตั้งค่าสถานะการเปิด-ปิดระบบลงทะเบียน (ฟังก์ชันสำรองแบบเดิม)
 */
function setRegistrationSystemStatus(targetStatus, requesterUid) {
  return setRegistrationSchedule(null, null, requesterUid, targetStatus);
}

/**
 * ⚠️ สำคัญมาก: กดปุ่ม ▶ Run (เรียกใช้) ฟังก์ชันนี้ 1 ครั้งใน Apps Script Editor
 * เพื่ออนุมัติสิทธิ์ (Authorize) ทั้งหมด:
 * 1) Google Drive (https://www.googleapis.com/auth/drive สำหรับอัปโหลดรูปจาก LINE)
 * 2) Google Sheets (https://www.googleapis.com/auth/spreadsheets)
 * 3) LINE API (https://www.googleapis.com/auth/script.external_request)
 */
function setupAndAuthorize() {
  const folder = getTargetDriveFolder();
  const tempBlob = Utilities.newBlob('auth_check', 'text/plain', 'auth_check.txt');
  const tempFile = folder.createFile(tempBlob);
  tempFile.setTrashed(true);
  const rootTemp = DriveApp.createFile(tempBlob);
  rootTemp.setTrashed(true);
  Logger.log('✅ เชื่อมต่อและทดสอบสร้างไฟล์ใน Google Drive สำเร็จ! โฟลเดอร์สำหรับเก็บรูป: ' + folder.getName() + ' (ID: ' + folder.getId() + ')');

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  Logger.log('✅ เชื่อมต่อ Google Sheets สำเร็จ: ' + ss.getName());

  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + getLineBotAccessToken()
    },
    muteHttpExceptions: true
  });
  Logger.log('✅ ทดสอบสิทธิ์ UrlFetchApp.fetch (LINE Bot Info) สำเร็จ! HTTP ' + response.getResponseCode() + ': ' + response.getContentText());
}

/**
 * ดึงข้อมูลพนักงานจาก Sheet ตั้งต้น ("การตอบแบบฟอร์ม 1") โดยใช้ ScriptCache (TTL 5 นาที) ลดการอ่าน Sheet ซ้ำเมื่อมีคนสแกนพร้อมกันจำนวนมาก
 */
function getSourceEmployeeByIdCached(empId) {
  const searchId = String(empId || '').trim().replace(/\.0$/, '');
  if (!searchId) {
    return { status: 'error', message: 'กรุณาระบุรหัสพนักงาน' };
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'SOURCE_EMP_MAP_V1';
  let compactMap = null;

  try {
    const cachedJson = cache.get(cacheKey);
    if (cachedJson) {
      const parsed = JSON.parse(cachedJson);
      if (parsed && typeof parsed === 'object') {
        compactMap = parsed;
      }
    }
  } catch (cacheReadErr) {}

  if (!compactMap) {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sourceSheet = getSheetSafely(ss, SOURCE_SHEET_NAME);

    if (!sourceSheet) {
      return { status: 'error', message: `ไม่พบแผ่นงาน "${SOURCE_SHEET_NAME}"` };
    }

    const lastRow = sourceSheet.getLastRow();
    if (lastRow < 2) {
      return { status: 'not_found', message: 'ไม่พบข้อมูลในระบบตั้งต้น' };
    }

    // ดึงข้อมูลตั้งแต่แถวที่ 2 ถึงแถวสุดท้าย (คอลัมน์ A ถึง F หรือคอลัมน์ทั้งหมด)
    const maxCols = Math.max(6, sourceSheet.getLastColumn());
    const data = sourceSheet.getRange(2, 1, lastRow - 1, maxCols).getValues();
    const headers = sourceSheet.getRange(1, 1, 1, maxCols).getValues()[0];

    let attendColIdx = 5;
    for (let h = 0; h < headers.length; h++) {
      const hText = String(headers[h] || '').trim();
      if (hText.indexOf('สนใจร่วมงาน') !== -1 || hText.indexOf('ร่วมงานหรือไม่') !== -1) {
        attendColIdx = h;
        break;
      }
    }

    const headerC = String(headers[2] || '');
    const headerD = String(headers[3] || '');
    const isColCName = headerC.indexOf('ชื่อ') !== -1 && headerD.indexOf('แผนก') !== -1;

    compactMap = {};
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowEmpId = String(row[1] || '').trim().replace(/\.0$/, '');
      if (!rowEmpId || rowEmpId === 'รหัสพนักงาน') continue;

      const rowColC = String(row[2] || '').trim();
      const rowColD = String(row[3] || '').trim();
      const rowColE = String(row[4] || '').trim();
      const empName = isColCName ? rowColC : rowColD;
      const department = isColCName ? rowColD : rowColC;
      const rawAttend = String(row[attendColIdx] || '').trim();
      const isNotAttending = rawAttend.indexOf('ไม่') !== -1 || (rawAttend.indexOf('ไป') === -1 && rawAttend !== '');

      compactMap[rowEmpId] = [empName, department, rowColE, rawAttend, isNotAttending ? 1 : 0];
    }

    try {
      const serialized = JSON.stringify(compactMap);
      if (serialized.length < 95000) {
        cache.put(cacheKey, serialized, 300);
      }
    } catch (cachePutErr) {}
  }

  const tuple = compactMap[searchId];
  if (!tuple) {
    return { status: 'not_found', message: 'ไม่พบรหัสพนักงานนี้ในรายชื่อตั้งต้น' };
  }

  return {
    status: 'ok',
    employee: {
      empId: searchId,
      empName: String(tuple[0] || ''),
      department: String(tuple[1] || ''),
      branch: String(tuple[2] || ''),
      attendAnswer: String(tuple[3] || ''),
      isNotAttending: Boolean(tuple[4])
    }
  };
}

/**
 * สำหรับเรียกใช้งานจากหน้าเว็บผ่าน google.script.run หรือ doGet(?action=checkEmployee&empId=...)
 * ค้นหารหัสพนักงานจาก B2:B และดึง แผนก (C2:C), ชื่อพนักงาน (D2:D), สาขา (E2:E)
 */
function checkEmployeeById(empId) {
  try {
    if (!empId) {
      return { status: 'error', message: 'กรุณาระบุรหัสพนักงาน' };
    }

    const searchId = String(empId).trim().replace(/\.0$/, '');
    const sourceRes = getSourceEmployeeByIdCached(searchId);
    if (!sourceRes || sourceRes.status !== 'ok' || !sourceRes.employee) {
      return {
        status: (sourceRes && sourceRes.status) || 'not_found',
        message: (sourceRes && sourceRes.message) || 'ไม่พบรหัสพนักงานนี้ในรายชื่อตั้งต้น'
      };
    }

    const foundEmployee = sourceRes.employee;

    // ตรวจสอบคอลัมน์ "ท่านสนใจร่วมงานหรือไม่?" หากตอบ "ไม่ไป" หรือไม่มาร่วมงาน ไม่อนุญาตให้ลงทะเบียน
    if (foundEmployee.isNotAttending) {
      return {
        status: 'not_attending',
        message: 'ท่านไม่ได้มาร่วมงานลงทะเบียนไม่ได้',
        data: foundEmployee
      };
    }

    // ตรวจสอบว่าลงทะเบียนไปแล้วหรือยังใน Sheet Register
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const regSheet = getSheetSafely(ss, TARGET_SHEET_NAME);
    let alreadyRegistered = false;
    let registeredAt = '';

    if (regSheet && regSheet.getLastRow() >= 2) {
      const regData = regSheet.getRange(2, 1, regSheet.getLastRow() - 1, 2).getValues();
      for (let j = 0; j < regData.length; j++) {
        const regEmpId = String(regData[j][1] || '').trim().replace(/\.0$/, '');
        if (regEmpId === searchId) {
          alreadyRegistered = true;
          registeredAt = regData[j][0]
            ? Utilities.formatDate(new Date(regData[j][0]), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss')
            : '';
          break;
        }
      }
    }

    return {
      status: 'success',
      data: foundEmployee,
      alreadyRegistered: alreadyRegistered,
      registeredAt: registeredAt,
      message: alreadyRegistered ? 'รหัสพนักงานนี้ได้ลงทะเบียนไปแล้ว' : ''
    };
  } catch (err) {
    console.error('Error in checkEmployeeById:', err);
    return { status: 'error', message: err.message };
  }
}

/**
 * ตรวจสอบว่า LINE UID นี้เคยลงทะเบียนใน Sheet "Register" ไปแล้วหรือยัง
 */
function checkRegistrationByUid(uid) {
  try {
    const searchUid = String(uid || '').trim();
    if (!searchUid || searchUid === 'TEST_USER') {
      return { status: 'success', registered: false };
    }

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const regSheet = getSheetSafely(ss, TARGET_SHEET_NAME);
    if (!regSheet || regSheet.getLastRow() < 2) {
      return { status: 'success', registered: false };
    }

    const lastRow = regSheet.getLastRow();
    // คอลัมน์ A(0)=ประทับเวลา, B(1)=รหัสพนักงาน, C(2)=แผนก, D(3)=ชื่อ-สกุล, E(4)=สาขา, F(5)=LINE UID
    const data = regSheet.getRange(2, 1, lastRow - 1, Math.max(6, regSheet.getLastColumn())).getValues();

    for (let i = data.length - 1; i >= 0; i--) {
      const row = data[i];
      const rowUid = String(row[5] || '').trim();
      if (rowUid === searchUid) {
        const regTime = row[0]
          ? Utilities.formatDate(new Date(row[0]), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss')
          : '';
        return {
          status: 'success',
          registered: true,
          data: {
            timestamp: regTime,
            empId: String(row[1] || '').trim(),
            department: String(row[2] || '').trim(),
            empName: String(row[3] || '').trim(),
            branch: String(row[4] || '').trim(),
            uid: rowUid
          }
        };
      }
    }

    return { status: 'success', registered: false };
  } catch (err) {
    console.error('Error in checkRegistrationByUid:', err);
    return { status: 'error', message: err.message };
  }
}

/**
 * บันทึกข้อมูลการลงทะเบียนลงใน Sheet "Register" (ล็อกสั้นที่สุดเท่าที่จำเป็นและปล่อย Lock ก่อนยิง LINE Push)
 */
function saveRegistrationData(payload) {
  const lock = LockService.getScriptLock();
  let lockHeld = false;
  try {
    const empId = String(payload.empId || '').trim().replace(/\.0$/, '');
    const empName = String(payload.empName || '').trim();
    const department = String(payload.department || '').trim();
    const branch = String(payload.branch || '').trim();
    const uid = String(payload.uid || '').trim();
    const displayName = String(payload.displayName || '').trim();
    const pictureUrl = String(payload.pictureUrl || '').trim();

    if (!empId || !empName) {
      return { status: 'error', message: 'ข้อมูลพนักงานไม่ครบถ้วน กรุณาตรวจสอบรหัสพนักงานอีกครั้ง' };
    }

    // 1. ตรวจสอบสิทธิ์เปิด-ปิดระบบ และข้อมูลตั้งต้น/ความเป็นเพื่อน ก่อนขอ Lock
    const sysStatusInfo = getRegistrationSystemStatus();
    if (!sysStatusInfo.isOpen && !isAdminAuthorized(payload)) {
      if (sysStatusInfo.isBeforeOpeningTime && sysStatusInfo.openingDateTime) {
        return {
          status: 'error',
          message: `ขณะนี้ยังไม่ถึงเวลาเปิดระบบลงทะเบียน (เปิดเวลา ${sysStatusInfo.openingDateTime.replace('T', ' ')})`
        };
      }
      let closeMsg = 'ขณะนี้ระบบลงทะเบียนปิดรับข้อมูลแล้ว';
      if (sysStatusInfo.closingDateTime) {
        closeMsg += ` (หมดเวลาเมื่อ ${sysStatusInfo.closingDateTime.replace('T', ' ')})`;
      }
      return { status: 'error', message: closeMsg };
    }

    const sourceCheck = getSourceEmployeeByIdCached(empId);
    if (sourceCheck && sourceCheck.status === 'ok' && sourceCheck.employee && sourceCheck.employee.isNotAttending) {
      return { status: 'error', message: 'ท่านไม่ได้มาร่วมงานลงทะเบียนไม่ได้' };
    }

    if (uid && uid !== 'TEST_USER' && !isUserFriendWithBot(uid, false)) {
      return { status: 'error', message: 'กรุณากดเพิ่มเพื่อน LINE กับ cmparty2026 ก่อนทำการลงทะเบียน' };
    }

    // 2. ช่วงสั้นใน Lock: ตรวจซ้ำบน Sheet Register และเขียนแถวใหม่ทันที
    lock.waitLock(10000);
    lockHeld = true;

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let regSheet = getSheetSafely(ss, TARGET_SHEET_NAME);

    if (!regSheet) {
      regSheet = ss.insertSheet(TARGET_SHEET_NAME);
    }

    const headers = [
      'ประทับเวลา',
      'รหัสพนักงาน',
      'แผนก',
      'ชื่อ-สกุล',
      'สาขา',
      'LINE UID',
      'ชื่อ LINE',
      'รูปโปรไฟล์ LINE',
      'สถานะ'
    ];

    const lastRow = regSheet.getLastRow();
    const firstCellVal = lastRow > 0 ? String(regSheet.getRange(1, 1).getValue() || '').trim() : '';

    if (lastRow === 0 || firstCellVal === '') {
      regSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      regSheet.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold')
        .setBackground('#991b1b')
        .setFontColor('#ffffff');
      regSheet.setFrozenRows(1);
    } else if (lastRow >= 2) {
      const existingData = regSheet.getRange(2, 2, lastRow - 1, 5).getValues(); // คอลัมน์ B ถึง F
      for (let i = 0; i < existingData.length; i++) {
        const rowEmpId = String(existingData[i][0] || '').trim().replace(/\.0$/, '');
        if (rowEmpId && rowEmpId === empId) {
          return {
            status: 'duplicate',
            message: 'รหัสพนักงานนี้ได้ลงทะเบียนไปแล้ว'
          };
        }
      }
      for (let i = 0; i < existingData.length; i++) {
        const rowUid = String(existingData[i][4] || '').trim();
        if (uid && rowUid === uid) {
          return {
            status: 'duplicate_uid',
            message: 'ท่านได้ลงทะเบียนแล้ว',
            data: {
              empId: String(existingData[i][0] || '').trim().replace(/\.0$/, ''),
              department: String(existingData[i][1] || '').trim(),
              empName: String(existingData[i][2] || '').trim(),
              branch: String(existingData[i][3] || '').trim(),
              uid: rowUid
            }
          };
        }
      }
    }

    const now = new Date();
    const formattedTime = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

    regSheet.appendRow([
      now,
      empId,
      department,
      empName,
      branch,
      uid,
      displayName,
      pictureUrl,
      'ลงทะเบียนสำเร็จ'
    ]);
    SpreadsheetApp.flush();

    lock.releaseLock();
    lockHeld = false;

    // 3. นอก Lock: ล้างแคชตุ๊กตาหน้าเวทีและส่งบัตรยืนยันผ่าน LINE Push API
    try {
      CacheService.getScriptCache().remove('STAGE_ATTENDEES_CACHE');
    } catch (cErr) {}

    let lineSent = false;
    let lineMessageStatus = '';
    if (uid && uid !== 'TEST_USER') {
      try {
        const pushRes = pushRegistrationFlexMessage(uid, {
          empId: empId,
          empName: empName,
          department: department,
          branch: branch,
          displayName: displayName,
          pictureUrl: pictureUrl,
          timestamp: formattedTime
        });
        lineSent = Boolean(pushRes && pushRes.success);
        lineMessageStatus = (pushRes && pushRes.message) || '';
      } catch (pushErr) {
        console.error('Error pushing registration Flex Message:', pushErr);
        lineMessageStatus = pushErr.message;
      }
    }

    return {
      status: 'success',
      message: 'บันทึกการลงทะเบียนเข้างานสำเร็จ',
      timestamp: formattedTime,
      lineSent: lineSent,
      lineMessageStatus: lineMessageStatus,
      data: {
        empId: empId,
        empName: empName,
        department: department,
        branch: branch,
        uid: uid,
        displayName: displayName,
        timestamp: formattedTime
      }
    };
  } catch (err) {
    console.error('Error in saveRegistrationData:', err);
    return { status: 'error', message: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล: ' + err.message };
  } finally {
    if (lockHeld) {
      lock.releaseLock();
    }
  }
}

/**
 * สร้างโครงสร้าง Flex Message ธีมคริสต์มาสโปร่งแสงแบบรวมศูนย์ (ใช้ร่วมกันทุกการ์ด)
 */
function buildChristmasGlassFlexMessage(opts) {
  const footerBox = {
    type: 'box',
    layout: 'vertical',
    backgroundColor: opts.footerBgColor || '#14532DB8',
    borderColor: '#86EFAC44',
    borderWidth: '1px',
    cornerRadius: '14px',
    paddingAll: '12px',
    contents: opts.footerContents || []
  };
  if (opts.footerSpacing) {
    footerBox.spacing = opts.footerSpacing;
  }

  const flexMsg = {
    type: 'flex',
    altText: opts.altText,
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '0px',
        contents: [
          {
            type: 'image',
            url: opts.bgImageUrl,
            position: 'absolute',
            offsetTop: '0px',
            offsetBottom: '0px',
            offsetStart: '0px',
            offsetEnd: '0px',
            size: 'full',
            aspectMode: 'cover'
          },
          {
            type: 'box',
            layout: 'vertical',
            paddingAll: '16px',
            spacing: 'md',
            background: {
              type: 'linearGradient',
              angle: '180deg',
              startColor: '#14030700',
              centerColor: '#14030788',
              endColor: '#140307E6',
              centerPosition: '36%'
            },
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                alignItems: 'center',
                contents: [
                  {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: opts.badgeBgColor || '#F5B942',
                    cornerRadius: '20px',
                    paddingStart: '10px',
                    paddingEnd: '10px',
                    paddingTop: '4px',
                    paddingBottom: '4px',
                    flex: 0,
                    contents: [
                      {
                        type: 'text',
                        text: opts.badgeText,
                        color: opts.badgeTextColor || '#78350F',
                        size: 'xxs',
                        weight: 'bold'
                      }
                    ]
                  },
                  {
                    type: 'text',
                    text: opts.rightLabel || 'CM PARTY',
                    color: '#FDE68A',
                    size: opts.rightLabelSize || 'xs',
                    weight: 'bold',
                    align: 'end'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                height: '88px',
                contents: []
              },
              {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'text',
                    text: opts.title,
                    color: '#FFFFFF',
                    size: 'xl',
                    weight: 'bold'
                  },
                  {
                    type: 'text',
                    text: opts.subtitle,
                    color: '#FDE68A',
                    size: 'xs',
                    margin: 'xs'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#1204077A',
                borderColor: '#FDE68A55',
                borderWidth: '1px',
                cornerRadius: '16px',
                paddingAll: '14px',
                spacing: 'md',
                contents: opts.glassCardContents || []
              },
              footerBox
            ]
          }
        ]
      }
    }
  };
  return opts.senderKey ? withBotSender(flexMsg, opts.senderKey) : flexMsg;
}

function buildFlexInfoRow(label, value, valueColor, valueSize, valueWeight, spacing) {
  const valueText = {
    type: 'text',
    text: String(value || '-'),
    color: valueColor || '#FFFFFF',
    size: valueSize || 'xs',
    flex: 6,
    wrap: true
  };
  if (valueWeight) {
    valueText.weight = valueWeight;
  }
  const row = {
    type: 'box',
    layout: 'baseline',
    contents: [
      { type: 'text', text: label, color: '#FDE68A', size: 'xs', flex: 4 },
      valueText
    ]
  };
  if (spacing) {
    row.spacing = spacing;
  }
  return row;
}

/**
 * ส่ง LINE Push Message (Flex Message บัตรเข้างาน VIP Pass) แจ้งยืนยันการลงทะเบียนสำเร็จเข้าแชทของผู้ลงทะเบียนโดยตรง
 */
function pushRegistrationFlexMessage(uid, info) {
  const token = getLineBotAccessToken();

  const profilePic = (info.pictureUrl && String(info.pictureUrl).indexOf('https://') === 0)
    ? String(info.pictureUrl)
    : 'https://cdn-icons-png.flaticon.com/512/847/847969.png';

  const lineName = String(info.displayName || 'ผู้เข้าร่วมงาน');
  const empName = String(info.empName || '-');
  const empId = String(info.empId || '-');
  const department = String(info.department || '-');
  const branch = String(info.branch || '-');
  const timestamp = String(info.timestamp || Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss'));

  const ticketFlexMessage = buildChristmasGlassFlexMessage({
    senderKey: 'elf',
    altText: `บัตรเข้างาน CM Party - ${empName} (รหัส ${empId}) ลงทะเบียนสำเร็จแล้ว`,
    bgImageUrl: 'https://cmparty.vercel.app/assets/flex-envelope.jpg',
    badgeText: 'VIP PASS',
    rightLabel: 'CHRISTMAS & NEW YEAR',
    rightLabelSize: 'xxs',
    title: 'CM PARTY TICKET',
    subtitle: 'บัตรยืนยันการลงทะเบียนเข้างานเลี้ยงสำเร็จแล้ว',
    glassCardContents: [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
        alignItems: 'center',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            width: '60px',
            height: '60px',
            cornerRadius: '30px',
            borderWidth: '2px',
            borderColor: '#86EFAC',
            flex: 0,
            contents: [
              {
                type: 'image',
                url: profilePic,
                size: 'full',
                aspectMode: 'cover',
                aspectRatio: '1:1'
              }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                contents: [
                  {
                    type: 'box',
                    layout: 'vertical',
                    backgroundColor: '#15803DCC',
                    cornerRadius: '6px',
                    paddingStart: '8px',
                    paddingEnd: '8px',
                    paddingTop: '2px',
                    paddingBottom: '2px',
                    flex: 0,
                    contents: [
                      {
                        type: 'text',
                        text: 'ลงทะเบียนสำเร็จ',
                        color: '#DCFCE7',
                        size: 'xxs',
                        weight: 'bold'
                      }
                    ]
                  }
                ]
              },
              {
                type: 'text',
                text: empName,
                weight: 'bold',
                size: 'md',
                color: '#FFFFFF',
                wrap: true
              },
              {
                type: 'text',
                text: 'LINE: ' + lineName,
                size: 'xs',
                color: '#FECACA',
                wrap: true
              }
            ]
          }
        ]
      },
      {
        type: 'separator',
        color: '#FFFFFF33'
      },
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#00000040',
        cornerRadius: '12px',
        paddingAll: '12px',
        spacing: 'sm',
        borderWidth: '1px',
        borderColor: '#FDE68A44',
        contents: [
          buildFlexInfoRow('รหัสพนักงาน', empId, '#FFFFFF', 'sm', 'bold', 'sm'),
          buildFlexInfoRow('แผนก', department, '#F3F4F6', 'xs', 'bold', 'sm'),
          buildFlexInfoRow('สาขา', branch, '#86EFAC', 'xs', 'bold', 'sm')
        ]
      }
    ],
    footerSpacing: 'xs',
    footerContents: [
      {
        type: 'box',
        layout: 'horizontal',
        alignItems: 'center',
        contents: [
          {
            type: 'text',
            text: 'STATUS: REGISTERED',
            color: '#86EFAC',
            size: 'xxs',
            weight: 'bold',
            flex: 1
          },
          {
            type: 'text',
            text: timestamp,
            color: '#DCFCE7',
            size: 'xxs',
            align: 'end',
            flex: 1
          }
        ]
      },
      {
        type: 'text',
        text: 'กรุณาแสดงบัตรนี้ที่จุดลงทะเบียนหน้างาน',
        color: '#FEF08A',
        size: 'xxs',
        align: 'center',
        margin: 'xs'
      }
    ]
  });

  const url = 'https://api.line.me/v2/bot/message/push';
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token
    },
    payload: JSON.stringify({
      to: uid,
      messages: [ticketFlexMessage]
    }),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code >= 200 && code < 300) {
    return { success: true, message: 'ส่งบัตรเข้างานเข้า LINE สำเร็จ' };
  } else {
    console.error('LINE Registration Push Error (' + code + '): ' + body);
    return { success: false, message: `LINE API Error (${code}): ${body}` };
  }
}

/**
 * Helper ค้นหาชื่อ Sheet แบบรองรับกรณีมีช่องว่างต่อท้ายชื่อแท็บ (เช่น "Register ")
 */
function getSheetSafely(ss, targetName) {
  let sheet = ss.getSheetByName(targetName);
  if (sheet) return sheet;

  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().trim().toLowerCase() === targetName.trim().toLowerCase()) {
      return sheets[i];
    }
  }
  return null;
}

/**
 * ดึงรายการรูปภาพทั้งหมดจากโฟลเดอร์ Google Drive (1Mob3ioDYe_67dLNHp3zQR4tGl2EtFJ-L)
 * แปลงลิงก์รูปภาพเป็น https://lh5.googleusercontent.com/d/{id} ตามที่ผู้ใช้ต้องการ
 */
function getGalleryImages(bypassCache) {
  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = 'GALLERY_IMAGES_CACHE';
    const sharedCacheKey = 'GALLERY_SHARED_FILE_IDS';

    if (!bypassCache) {
      const cachedData = cache.get(cacheKey);
      if (cachedData) {
        try {
          return JSON.parse(cachedData);
        } catch (cErr) {}
      }
    }

    // โหลดรายชื่อ File ID ที่เคยตั้งค่าแชร์สาธารณะแล้ว เพื่อลดเวลาสแกน Drive ระหว่างซิงค์อัตโนมัติ
    const sharedIdsSet = {};
    let sharedCacheDirty = false;
    try {
      const cachedSharedJson = cache.get(sharedCacheKey);
      if (cachedSharedJson) {
        const parsedIds = JSON.parse(cachedSharedJson);
        if (Array.isArray(parsedIds)) {
          parsedIds.forEach(id => { sharedIdsSet[id] = true; });
        }
      }
    } catch (sharedReadErr) {}

    const folderId = (typeof LINE_DRIVE_FOLDER_ID !== 'undefined' && LINE_DRIVE_FOLDER_ID)
      ? LINE_DRIVE_FOLDER_ID.trim()
      : '1Mob3ioDYe_67dLNHp3zQR4tGl2EtFJ-L';

    let folder;
    try {
      folder = DriveApp.getFolderById(folderId);
    } catch (fErr) {
      folder = getTargetDriveFolder();
    }

    if (!folder) {
      return { status: 'error', message: 'ไม่พบโฟลเดอร์ Google Drive สำหรับเก็บรูปภาพ' };
    }

    const images = [];

    // ฟังก์ชันช่วยเก็บไฟล์รูปภาพจากโฟลเดอร์
    function collectImagesFromFolder(targetFolder) {
      const files = targetFolder.getFiles();
      while (files.hasNext()) {
        const file = files.next();
        const mime = String(file.getMimeType() || '').toLowerCase();
        const name = file.getName();

        const isImageMime = mime.indexOf('image/') !== -1;
        const isImageExt = /\.(jpg|jpeg|png|webp|gif|heic|bmp)$/i.test(name);

        if (isImageMime || isImageExt) {
          const fileId = file.getId();

          // พยายามตั้งค่าแชร์ไฟล์เป็นสาธารณะ (Anyone with link view) เฉพาะไฟล์ที่ยังไม่เคยเช็ค เพื่อให้ lh5 โหลดภาพได้และซิงค์เร็วขึ้น
          if (!sharedIdsSet[fileId]) {
            try {
              if (file.getSharingAccess() !== DriveApp.Access.ANYONE_WITH_LINK) {
                file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
              }
              sharedIdsSet[fileId] = true;
              sharedCacheDirty = true;
            } catch (shareErr) {}
          }

          const createdDate = file.getDateCreated();
          const formattedDate = createdDate
            ? Utilities.formatDate(createdDate, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss')
            : '';

          images.push({
            id: fileId,
            name: name,
            size: file.getSize(),
            date: formattedDate,
            timestamp: createdDate ? createdDate.getTime() : 0
          });
        }
      }

      // วนหาโฟลเดอร์ย่อย (ถ้ามี)
      const subfolders = targetFolder.getFolders();
      while (subfolders.hasNext()) {
        collectImagesFromFolder(subfolders.next());
      }
    }

    collectImagesFromFolder(folder);

    if (sharedCacheDirty) {
      try {
        const sharedIdsJson = JSON.stringify(Object.keys(sharedIdsSet));
        if (sharedIdsJson.length < 95000) {
          cache.put(sharedCacheKey, sharedIdsJson, 1800);
        }
      } catch (sharedWriteErr) {}
    }

    // เรียงลำดับจากรูปล่าสุดไปหารูปแรกสุด (ใหม่สุดอยู่บน)
    images.sort((a, b) => b.timestamp - a.timestamp);

    const result = {
      status: 'success',
      total: images.length,
      folderId: folder.getId(),
      folderName: folder.getName(),
      folderUrl: `https://drive.google.com/drive/folders/${folder.getId()}?usp=sharing`,
      images: images,
      fetchedAt: Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss'),
      serverTimestamp: Date.now()
    };

    // จำผลลัพธ์แบบกระชับลง Cache 15 วินาที (รองรับรูปได้ ~800+ ภาพใน Cache เดียว และล้างทันทีเมื่อมีภาพอัปโหลดใหม่)
    try {
      const jsonStr = JSON.stringify(result);
      if (jsonStr.length < 95000) {
        cache.put(cacheKey, jsonStr, 15);
      }
    } catch (cachePutErr) {}

    return result;
  } catch (err) {
    console.error('Error in getGalleryImages:', err);
    return { status: 'error', message: err.message };
  }
}

/**
 * Entry Point หลักสำหรับ Web App (doGet & doPost)
 * - doGet: แสดงหน้าเว็บลงทะเบียน (index.html) หรือตอบกลับ JSON เมื่อส่งพารามิเตอร์ ?action=checkEmployee&empId=...
 * - doPost: รองรับทั้งการบันทึกข้อมูลลงทะเบียนเข้า Sheet "Register" และรับ Event จาก LINE Webhook อัตโนมัติ
 */
function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};

  // กรณีเรียกดูแกลเลอรีภาพกิจกรรมผ่าน GET API: ?action=getGalleryImages
  if (params.action === 'getGalleryImages' || params.action === 'getPhotos') {
    const bypassCache = params.nocache === '1' || params.nocache === 'true';
    const result = getGalleryImages(bypassCache);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีเรียกเช็คข้อมูลพนักงานผ่าน GET API: ?action=checkEmployee&empId=672002
  if (params.action === 'checkEmployee') {
    const result = checkEmployeeById(params.empId);
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีตรวจสอบว่า LINE UID นี้เคยลงทะเบียนแล้วหรือยัง: ?action=checkUid&uid=...
  if (params.action === 'checkUid') {
    const uidResult = checkRegistrationByUid(params.uid);
    return ContentService.createTextOutput(JSON.stringify(uidResult))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีตรวจสอบสถานะการเป็นเพื่อนกับ LINE Bot: ?action=checkFriendship&uid=...
  if (params.action === 'checkFriendship') {
    const checkUid = String(params.uid || '').trim();
    const bypassCache = params.nocache === '1';
    const isFriend = isUserFriendWithBot(checkUid, bypassCache);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      uid: checkUid,
      isFriend: isFriend
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีตรวจสอบสถานะเปิด-ปิดระบบลงทะเบียน: ?action=getSystemStatus
  if (params.action === 'getSystemStatus') {
    const verifiedAdminUid = getVerifiedAdminUid(params);
    const statusInfo = getRegistrationSystemStatus();
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      ...statusInfo,
      isAdmin: Boolean(verifiedAdminUid),
      isSuperAdmin: verifiedAdminUid === ADMIN_UID,
      serverTime: new Date().toISOString()
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีจัดการรายชื่อแอดมินผ่าน GET API (getAdmins / addAdmin / removeAdmin)
  if (params.action === 'getAdmins') {
    return ContentService.createTextOutput(JSON.stringify(getAdminManagementList(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'addAdmin') {
    return ContentService.createTextOutput(JSON.stringify(addExtraAdmin(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'removeAdmin') {
    return ContentService.createTextOutput(JSON.stringify(removeExtraAdmin(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'setupRichMenu') {
    return ContentService.createTextOutput(JSON.stringify(adminSetupLineRichMenu(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'clearRichMenu') {
    return ContentService.createTextOutput(JSON.stringify(adminClearLineRichMenu(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'inspectRichMenu') {
    return ContentService.createTextOutput(JSON.stringify(adminInspectLineRichMenus(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีแอดมินตั้งวันเวลาเปิด-ปิดระบบ หรือสลับเปิด-ปิดระบบ
  if (params.action === 'setSchedule' || params.action === 'setClosingDateTime' || params.action === 'toggleSystemStatus') {
    const openingDateTime = params.openingDateTime !== undefined ? params.openingDateTime : null;
    const closingDateTime = params.closingDateTime !== undefined ? params.closingDateTime : null;
    const manualStatus = params.targetStatus ? String(params.targetStatus) : null;
    const res = setRegistrationSchedule(openingDateTime, closingDateTime, params, manualStatus);
    return ContentService.createTextOutput(JSON.stringify(res))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีบันทึกข้อมูลผ่าน GET API (Fallback): ?action=saveRegistration&empId=...
  if (params.action === 'saveRegistration') {
    const saveResult = saveRegistrationData(params);
    return ContentService.createTextOutput(JSON.stringify(saveResult))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีสร้างหัวคอลัมน์ผ่าน GET API: ?action=initHeaders (เฉพาะแอดมินเท่านั้น)
  if (params.action === 'initHeaders') {
    if (!isAdminAuthorized(params)) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error',
        message: 'ไม่มีสิทธิ์ดำเนินการ (อนุญาตเฉพาะแอดมินเท่านั้น)'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    initRegisterSheetHeaders();
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Initialized Register sheet headers successfully'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีเช็คสถานะระบบ: ?action=status
  if (params.action === 'status') {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'ok',
      message: 'LINE Bot Webhook & CM Party Registration API is active!'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีจัดการข้อมูลรางวัล (Reward CRUD ผ่าน GET):
  // - ?action=getRewardInitData (เฉพาะแอดมิน)
  // - ?action=checkRegisteredEmployee&empId=... (เฉพาะแอดมิน - ค้นหาผู้ลงทะเบียนจาก Sheet Register เท่านั้น)
  // - ?action=getRewards (เฉพาะแอดมิน)
  // - ?action=saveReward&rowIndex=...&rewardName=...&empId=...
  // - ?action=deleteReward&rowIndex=...
  if (params.action === 'getRewardInitData') {
    return ContentService.createTextOutput(JSON.stringify(getRewardInitData(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'checkRegisteredEmployee') {
    return ContentService.createTextOutput(JSON.stringify(checkRegisteredEmployeeById(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'getRewards') {
    return ContentService.createTextOutput(JSON.stringify(getRewardsList(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'getStageAttendees') {
    return ContentService.createTextOutput(JSON.stringify(getPublicStageAttendees()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'saveReward') {
    return ContentService.createTextOutput(JSON.stringify(saveRewardRecord(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'saveBatchRewards') {
    return ContentService.createTextOutput(JSON.stringify(saveBatchRewards(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'deleteReward') {
    return ContentService.createTextOutput(JSON.stringify(deleteRewardRecord(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'syncShiftWorkers') {
    return ContentService.createTextOutput(JSON.stringify(handleSyncShiftWorkersAction(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'getLiveWishes') {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      wishes: getLivePartyWishes(),
      serverTime: Date.now()
    })).setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'resendRewardLine') {
    return ContentService.createTextOutput(JSON.stringify(resendRewardLineNotification(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'getStageState') {
    return ContentService.createTextOutput(JSON.stringify(getStageDisplayState()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'setStageState') {
    return ContentService.createTextOutput(JSON.stringify(setStageDisplayState(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // เปิดหน้าเว็บแกลเลอรีภาพกิจกรรม (gallery.html) เมื่อส่ง ?page=gallery หรือ ?page=photos
  if (params.page === 'gallery' || params.page === 'photos') {
    return HtmlService.createTemplateFromFile('gallery')
      .evaluate()
      .setTitle('📸 แกลเลอรีภาพกิจกรรม - CM Party')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // เปิดหน้าเว็บระบบบันทึกรางวัล (reward.html) เมื่อส่ง ?page=reward
  if (params.page === 'reward') {
    return HtmlService.createTemplateFromFile('reward')
      .evaluate()
      .setTitle('🎁 ระบบบันทึกและจัดการรางวัล - CM Party')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // เปิดหน้าจอใหญ่ประกาศผลรางวัล (stage.html) เมื่อส่ง ?page=stage
  if (params.page === 'stage') {
    return HtmlService.createTemplateFromFile('stage')
      .evaluate()
      .setTitle('🎉 หน้าจอประกาศผลรางวัล - CM Party 2026')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // เปิดหน้าเว็บระบบลงทะเบียนเข้างานเลี้ยง (index.html)
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('🎄 ลงทะเบียนเข้างานเลี้ยง - CM Party')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error',
        message: 'No postData received'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const payload = JSON.parse(e.postData.contents);

    // 1. หากเป็น Payload ที่ส่งมาจาก LINE Webhook (มีฟิลด์ events เป็น Array) -> ส่งต่อไปยังฟังก์ชันใน รหัส.js
    if (Array.isArray(payload.events)) {
      if (typeof handleLineWebhookPost === 'function') {
        return handleLineWebhookPost(e);
      }
    }

    // 2. หากเป็นการเรียกตรวจสอบรหัสพนักงานผ่าน POST
    if (payload.action === 'checkEmployee') {
      const checkRes = checkEmployeeById(payload.empId);
      return ContentService.createTextOutput(JSON.stringify(checkRes))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ตรวจสอบสถานะการเป็นเพื่อนผ่าน POST: action = checkFriendship
    if (payload.action === 'checkFriendship') {
      const checkUid = String(payload.uid || '').trim();
      const bypassCache = payload.nocache === true || payload.nocache === '1';
      const isFriend = isUserFriendWithBot(checkUid, bypassCache);
      return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        uid: checkUid,
        isFriend: isFriend
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // กรณีตรวจสอบสถานะเปิด-ปิดระบบลงทะเบียนผ่าน POST: action = getSystemStatus
    if (payload.action === 'getSystemStatus') {
      const verifiedAdminUid = getVerifiedAdminUid(payload);
      const statusInfo = getRegistrationSystemStatus();
      return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        ...statusInfo,
        isAdmin: Boolean(verifiedAdminUid),
        isSuperAdmin: verifiedAdminUid === ADMIN_UID,
        serverTime: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // กรณีจัดการรายชื่อแอดมินผ่าน POST API (getAdmins / addAdmin / removeAdmin)
    if (payload.action === 'getAdmins') {
      return ContentService.createTextOutput(JSON.stringify(getAdminManagementList(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'addAdmin') {
      return ContentService.createTextOutput(JSON.stringify(addExtraAdmin(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'removeAdmin') {
      return ContentService.createTextOutput(JSON.stringify(removeExtraAdmin(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'setupRichMenu') {
      return ContentService.createTextOutput(JSON.stringify(adminSetupLineRichMenu(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'clearRichMenu') {
      return ContentService.createTextOutput(JSON.stringify(adminClearLineRichMenu(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'inspectRichMenu') {
      return ContentService.createTextOutput(JSON.stringify(adminInspectLineRichMenus(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // กรณีแอดมินตั้งวันเวลาเปิด-ปิดระบบผ่าน POST: action = setSchedule, setClosingDateTime หรือ toggleSystemStatus
    if (payload.action === 'setSchedule' || payload.action === 'setClosingDateTime' || payload.action === 'toggleSystemStatus') {
      const openingDateTime = payload.openingDateTime !== undefined ? payload.openingDateTime : null;
      const closingDateTime = payload.closingDateTime !== undefined ? payload.closingDateTime : null;
      const manualStatus = payload.targetStatus ? String(payload.targetStatus) : null;
      const res = setRegistrationSchedule(openingDateTime, closingDateTime, payload, manualStatus);
      return ContentService.createTextOutput(JSON.stringify(res))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. หากเป็นการจัดการข้อมูลรางวัล (Reward CRUD ผ่าน POST)
    if (payload.action === 'getGalleryImages' || payload.action === 'getPhotos') {
      const bypassCache = payload.nocache === true || payload.nocache === '1';
      return ContentService.createTextOutput(JSON.stringify(getGalleryImages(bypassCache)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'getRewardInitData') {
      return ContentService.createTextOutput(JSON.stringify(getRewardInitData(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'checkRegisteredEmployee') {
      return ContentService.createTextOutput(JSON.stringify(checkRegisteredEmployeeById(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'getRewards') {
      return ContentService.createTextOutput(JSON.stringify(getRewardsList(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'getStageAttendees') {
      return ContentService.createTextOutput(JSON.stringify(getPublicStageAttendees()))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'saveReward') {
      return ContentService.createTextOutput(JSON.stringify(saveRewardRecord(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'saveBatchRewards') {
      return ContentService.createTextOutput(JSON.stringify(saveBatchRewards(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'deleteReward') {
      return ContentService.createTextOutput(JSON.stringify(deleteRewardRecord(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'syncShiftWorkers') {
      return ContentService.createTextOutput(JSON.stringify(handleSyncShiftWorkersAction(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'getLiveWishes') {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        wishes: getLivePartyWishes(),
        serverTime: Date.now()
      })).setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'resendRewardLine') {
      return ContentService.createTextOutput(JSON.stringify(resendRewardLineNotification(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'getStageState') {
      return ContentService.createTextOutput(JSON.stringify(getStageDisplayState()))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'setStageState') {
      return ContentService.createTextOutput(JSON.stringify(setStageDisplayState(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 4. บันทึกข้อมูลการลงทะเบียนลงใน Sheet "Register"
    const saveResult = saveRegistrationData(payload);
    return ContentService.createTextOutput(JSON.stringify(saveResult))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error('Error in doPost:', err);
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * กด Run ฟังก์ชันนี้ 1 ครั้งใน Google Apps Script Editor
 * เพื่ออนุมัติสิทธิ์เข้าถึง Google Sheets + UrlFetchApp (LINE API) และสร้างหัวคอลัมน์ในแผ่นงาน "Register" ทันที
 */
function initRegisterSheetHeaders() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let regSheet = getSheetSafely(ss, TARGET_SHEET_NAME);
  if (!regSheet) {
    regSheet = ss.insertSheet(TARGET_SHEET_NAME);
  }

  const headers = [
    'ประทับเวลา',
    'รหัสพนักงาน',
    'แผนก',
    'ชื่อ-สกุล',
    'สาขา',
    'LINE UID',
    'ชื่อ LINE',
    'รูปโปรไฟล์ LINE',
    'สถานะ'
  ];

  regSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  regSheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#991b1b')
    .setFontColor('#ffffff');
  regSheet.setFrozenRows(1);

  Logger.log('✅ สร้างหัวคอลัมน์ใน Sheet "' + regSheet.getName() + '" เรียบร้อยแล้ว!');

  // เรียก DriveApp.createFile จริง (แล้วลบลงถังขยะทันที) เพื่อบังคับให้ Google Apps Script ขอสิทธิ์ https://www.googleapis.com/auth/drive เต็มรูปแบบ
  const driveFolder = getTargetDriveFolder();
  const tempBlob = Utilities.newBlob('auth_check', 'text/plain', 'auth_check.txt');
  const tempFile = DriveApp.createFile(tempBlob);
  tempFile.setTrashed(true);
  Logger.log('✅ อนุมัติสิทธิ์สร้างไฟล์ Google Drive (createFile) สำเร็จ! โฟลเดอร์: ' + driveFolder.getName() + ' (ID: ' + driveFolder.getId() + ')');

  // เรียก UrlFetchApp.fetch เพื่อให้ Google Apps Script ขอสิทธิ์ https://www.googleapis.com/auth/script.external_request ทันทีที่กด Run
  const token = getLineBotAccessToken();
  const lineRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true
  });
  Logger.log('✅ อนุมัติสิทธิ์ UrlFetchApp.fetch สำเร็จ! (LINE API HTTP ' + lineRes.getResponseCode() + ')');
}

// ==========================================
// 9. ระบบบันทึกและจัดการรางวัล (Reward CRUD + LINE Push Flex Message)
// ดึงข้อมูลผู้ลงทะเบียนจาก Sheet "Register" เท่านั้น และบันทึกรางวัลลง Sheet gid=195154721
// ==========================================

/**
 * ค้นหาแผ่นงานรางวัลจากชื่อ Sheet "gift" หรือ Sheet ID (gid = 195154721)
 */
function getRewardSheet(ss) {
  const byGiftName = getSheetSafely(ss, GIFT_SHEET_NAME);
  if (byGiftName) return byGiftName;

  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === REWARD_SHEET_GID) {
      return sheets[i];
    }
  }
  // Fallback ค้นหาจากชื่อแท็บหากมีการเปลี่ยน gid
  return getSheetSafely(ss, 'Reward') || getSheetSafely(ss, 'รางวัล') || sheets[sheets.length - 1];
}

/**
 * อ่านรายชื่อผู้ลงทะเบียนทั้งหมดจาก Sheet "Register" เท่านั้น
 */
function getRegisteredEmployeesFromRegisterSheet(ss) {
  const uidMap = {};
  const employeesMap = {};
  const regSheet = getSheetSafely(ss, TARGET_SHEET_NAME);

  if (!regSheet || regSheet.getLastRow() < 2) {
    return { uidMap: uidMap, employeesMap: employeesMap };
  }

  const lastCol = Math.max(9, regSheet.getLastColumn());
  const headers = regSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const headerC = String(headers[2] || '');
  const headerD = String(headers[3] || '');
  const isColCName = headerC.indexOf('ชื่อ') !== -1 && headerD.indexOf('แผนก') !== -1;

  const regData = regSheet.getRange(2, 1, regSheet.getLastRow() - 1, lastCol).getValues();
  for (let i = 0; i < regData.length; i++) {
    const empId = String(regData[i][1] || '').trim().replace(/\.0$/, '');
    if (!empId || empId === 'รหัสพนักงาน') continue;

    const colC = String(regData[i][2] || '').trim();
    const colD = String(regData[i][3] || '').trim();
    const branch = String(regData[i][4] || '').trim();
    const uid = String(regData[i][5] || '').trim();
    const displayName = String(regData[i][6] || '').trim();
    const pic = String(regData[i][7] || '').trim();
    const regStatus = String(regData[i][8] || '').trim();

    const empName = isColCName ? colC : colD;
    const department = isColCName ? colD : colC;

    uidMap[empId] = { uid: uid, pictureUrl: pic };
    employeesMap[empId] = {
      empId: empId,
      empName: empName,
      department: department,
      branch: branch,
      uid: uid,
      displayName: displayName,
      pictureUrl: pic,
      regStatus: regStatus
    };
  }

  return { uidMap: uidMap, employeesMap: employeesMap };
}

/**
 * ซิงก์พนักงานที่ตอบแบบฟอร์มว่า "ไม่ได้ไปเพราะอยู่ กะ" จาก Sheet "การตอบแบบฟอร์ม 1"
 * เข้าสู่ Sheet "Register" อัตโนมัติ (เฉพาะรหัสที่ยังไม่ได้ลงทะเบียน และไม่เก็บข้อมูลอื่นเพิ่ม)
 */
function syncShiftWorkersToRegister(forceSync) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'SHIFT_AUTO_SYNC_RECENT';
  if (!forceSync && cache.get(cacheKey)) {
    return { status: 'success', skippedThrottle: true, addedCount: 0, addedIds: [] };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    return { status: 'success', skippedLock: true, addedCount: 0, addedIds: [] };
  }

  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sourceSheet = getSheetSafely(ss, SOURCE_SHEET_NAME);
    if (!sourceSheet || sourceSheet.getLastRow() < 2) {
      cache.put(cacheKey, '1', 60);
      return { status: 'success', addedCount: 0, addedIds: [] };
    }

    const srcLastRow = sourceSheet.getLastRow();
    const srcMaxCols = Math.max(6, sourceSheet.getLastColumn());
    const srcHeaders = sourceSheet.getRange(1, 1, 1, srcMaxCols).getValues()[0];
    const srcData = sourceSheet.getRange(2, 1, srcLastRow - 1, srcMaxCols).getValues();

    let attendColIdx = 5;
    for (let h = 0; h < srcHeaders.length; h++) {
      const hText = String(srcHeaders[h] || '').trim();
      if (hText.indexOf('สนใจร่วมงาน') !== -1 || hText.indexOf('ร่วมงานหรือไม่') !== -1) {
        attendColIdx = h;
        break;
      }
    }

    const headerC = String(srcHeaders[2] || '');
    const headerD = String(srcHeaders[3] || '');
    const isColCName = headerC.indexOf('ชื่อ') !== -1 && headerD.indexOf('แผนก') !== -1;

    // เก็บคำตอบแถวล่าสุดต่อ 1 รหัสพนักงาน (ป้องกันกรณีกรอกฟอร์มหลายรอบ)
    const latestByEmpId = {};
    for (let i = 0; i < srcData.length; i++) {
      const row = srcData[i];
      const empId = String(row[1] || '').trim().replace(/\.0$/, '');
      if (!empId || empId === 'รหัสพนักงาน') continue;

      const rowColC = String(row[2] || '').trim();
      const rowColD = String(row[3] || '').trim();
      const branch = String(row[4] || '').trim();
      const rawAttend = String(row[attendColIdx] || '').trim();

      latestByEmpId[empId] = {
        empId: empId,
        empName: isColCName ? rowColC : rowColD,
        department: isColCName ? rowColD : rowColC,
        branch: branch,
        rawAttend: rawAttend
      };
    }

    const shiftCandidates = Object.keys(latestByEmpId)
      .map(id => latestByEmpId[id])
      .filter(emp => emp.rawAttend === SHIFT_ATTEND_ANSWER_EXACT);

    if (shiftCandidates.length === 0) {
      cache.put(cacheKey, '1', 60);
      return { status: 'success', addedCount: 0, addedIds: [] };
    }

    let regSheet = getSheetSafely(ss, TARGET_SHEET_NAME);
    if (!regSheet) {
      regSheet = ss.insertSheet(TARGET_SHEET_NAME);
    }

    const headers = [
      'ประทับเวลา',
      'รหัสพนักงาน',
      'แผนก',
      'ชื่อ-สกุล',
      'สาขา',
      'LINE UID',
      'ชื่อ LINE',
      'รูปโปรไฟล์ LINE',
      'สถานะ'
    ];

    const regLastRow = regSheet.getLastRow();
    const firstCellVal = regLastRow > 0 ? String(regSheet.getRange(1, 1).getValue() || '').trim() : '';
    if (regLastRow === 0 || firstCellVal === '') {
      regSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      regSheet.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold')
        .setBackground('#991b1b')
        .setFontColor('#ffffff');
      regSheet.setFrozenRows(1);
    }

    const existingEmpIds = new Set();
    const currentLastRow = regSheet.getLastRow();
    if (currentLastRow >= 2) {
      const existingIdsCol = regSheet.getRange(2, 2, currentLastRow - 1, 1).getValues();
      for (let r = 0; r < existingIdsCol.length; r++) {
        const id = String(existingIdsCol[r][0] || '').trim().replace(/\.0$/, '');
        if (id) existingEmpIds.add(id);
      }
    }

    const now = new Date();
    const newRows = [];
    const addedIds = [];
    for (let c = 0; c < shiftCandidates.length; c++) {
      const emp = shiftCandidates[c];
      if (existingEmpIds.has(emp.empId)) continue;
      existingEmpIds.add(emp.empId);
      addedIds.push(emp.empId);
      newRows.push([
        now,
        emp.empId,
        emp.department,
        emp.empName,
        emp.branch,
        '',
        '',
        '',
        SHIFT_AUTO_REG_STATUS
      ]);
    }

    if (newRows.length > 0) {
      const startRow = Math.max(2, regSheet.getLastRow() + 1);
      regSheet.getRange(startRow, 1, newRows.length, headers.length).setValues(newRows);
    }

    cache.put(cacheKey, '1', 60);
    return {
      status: 'success',
      addedCount: newRows.length,
      addedIds: addedIds,
      totalShiftInForm: shiftCandidates.length
    };
  } catch (err) {
    console.error('Error in syncShiftWorkersToRegister:', err);
    return { status: 'error', message: err.message };
  } finally {
    lock.releaseLock();
  }
}

function handleSyncShiftWorkersAction(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการ (อนุญาตเฉพาะแอดมินเท่านั้น)' };
  }
  return syncShiftWorkersToRegister(true);
}

/**
 * กด Run ฟังก์ชันนี้ 1 ครั้งใน Apps Script Editor เพื่อตั้งเวลาซิงก์พนักงานอยู่กะอัตโนมัติทุก 5 นาที
 */
function setupShiftAutoSyncTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncShiftWorkersToRegister') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('syncShiftWorkersToRegister')
    .timeBased()
    .everyMinutes(5)
    .create();
  syncShiftWorkersToRegister(true);
  Logger.log('✅ ตั้งเวลาซิงก์พนักงานอยู่กะอัตโนมัติทุก 5 นาทีสำเร็จ');
}

/**
 * ค้นหาข้อมูลพนักงานเฉพาะผู้ที่ลงทะเบียนใน Sheet "Register" เท่านั้น (เฉพาะแอดมิน)
 */
function checkRegisteredEmployeeById(empIdOrPayload) {
  try {
    let rawEmpId = empIdOrPayload;
    if (empIdOrPayload && typeof empIdOrPayload === 'object') {
      if (!isAdminAuthorized(empIdOrPayload)) {
        return { status: 'error', message: 'ไม่มีสิทธิ์เข้าถึงข้อมูล (อนุญาตเฉพาะแอดมินเท่านั้น)' };
      }
      rawEmpId = empIdOrPayload.empId;
    }

    const searchId = String(rawEmpId || '').trim().replace(/\.0$/, '');
    if (!searchId) {
      return { status: 'error', message: 'กรุณาระบุรหัสพนักงาน' };
    }

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const { employeesMap } = getRegisteredEmployeesFromRegisterSheet(ss);
    const found = employeesMap[searchId];

    if (!found) {
      return {
        status: 'not_found',
        message: 'ไม่พบรหัสพนักงานนี้ใน Sheet Register (ยังไม่ได้ลงทะเบียนเข้างาน)'
      };
    }

    return {
      status: 'success',
      data: found
    };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/**
 * ดึงข้อมูลเริ่มต้นสำหรับหน้า reward.html ในครั้งเดียว (รายการรางวัลทั้งหมด + Map พนักงานที่ลงทะเบียนแล้วจาก Sheet "Register")
 * สงวนสิทธิ์เฉพาะแอดมินที่ผ่านการยืนยัน LINE Token แล้วเท่านั้น
 */
function getRewardInitData(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'error', message: 'ไม่มีสิทธิ์เข้าถึงข้อมูล (อนุญาตเฉพาะแอดมินเท่านั้น)' };
  }
  try {
    // ซิงก์คนที่มีเงื่อนไข "ไม่ได้ไปเพราะอยู่ กะ" เข้า Sheet Register อัตโนมัติ (จำกัดความถี่ไม่เกิน 1 ครั้ง/นาที)
    try {
      syncShiftWorkersToRegister(false);
    } catch (syncErr) {
      console.warn('Auto shift sync warning in getRewardInitData:', syncErr);
    }

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    // 1. ดึงรายชื่อพนักงานและ LINE UID จาก Sheet "Register" เท่านั้น
    const { uidMap, employeesMap } = getRegisteredEmployeesFromRegisterSheet(ss);

    // 2. ดึงรายการรางวัลทั้งหมดจาก Sheet รางวัล (gid=195154721)
    const rewardsResult = getRewardsListInternal(ss, uidMap);

    return {
      status: 'success',
      rewards: rewardsResult,
      employees: employeesMap
    };
  } catch (err) {
    console.error('Error in getRewardInitData:', err);
    return { status: 'error', message: err.message };
  }
}

function getRewardsList(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'error', message: 'ไม่มีสิทธิ์เข้าถึงข้อมูล (อนุญาตเฉพาะแอดมินเท่านั้น)' };
  }
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const { uidMap } = getRegisteredEmployeesFromRegisterSheet(ss);
    const rewards = getRewardsListInternal(ss, uidMap);
    return { status: 'success', rewards: rewards };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/**
 * ดึงข้อมูลสำหรับแสดงตุ๊กตาผู้ร่วมงานหน้าเวทีใน gallery.html (เฉพาะ empId, displayName, pictureUrl ไม่เปิดเผย LINE UID)
 */
function getPublicStageAttendees() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'STAGE_ATTENDEES_CACHE';
  try {
    const cached = cache.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (e) {}

  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const { employeesMap } = getRegisteredEmployeesFromRegisterSheet(ss);
    const attendees = [];
    Object.keys(employeesMap).forEach(k => {
      const emp = employeesMap[k];
      if (!emp || !emp.empId) return;
      if (String(emp.regStatus || '').indexOf('อยู่กะ') !== -1) return;
      attendees.push({
        empId: String(emp.empId || '').trim(),
        displayName: String(emp.displayName || emp.empName || emp.empId || '').trim(),
        pictureUrl: String(emp.pictureUrl || '').trim()
      });
    });

    const result = {
      status: 'success',
      attendees: attendees
    };
    try {
      cache.put(cacheKey, JSON.stringify(result), 10);
    } catch (cErr) {}
    return result;
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

function getRewardsListInternal(ss, uidMap) {
  const rewardSheet = getRewardSheet(ss);
  if (!rewardSheet) return [];

  const lastRow = rewardSheet.getLastRow();
  if (lastRow < 2) return [];

  // โครงสร้าง Sheet gift: A(0)=ชื่อรางวัล, B(1)=รหัสพนักงาน, C(2)=ชื่อ, D(3)=แผนก, E(4)=สาขา, F(5)=uid
  const values = rewardSheet.getRange(2, 1, lastRow - 1, 6).getValues();
  const list = [];

  for (let i = 0; i < values.length; i++) {
    const rowNumber = i + 2;
    const rewardName = String(values[i][0] || '').trim();
    const empId = String(values[i][1] || '').trim().replace(/\.0$/, '');
    const empName = String(values[i][2] || '').trim();
    const department = String(values[i][3] || '').trim();
    const branch = String(values[i][4] || '').trim();
    let uid = String(values[i][5] || '').trim();

    if (!uid && empId && uidMap && uidMap[empId]) {
      uid = uidMap[empId].uid || '';
    }

    if (rewardName || empId) {
      list.push({
        rowIndex: rowNumber,
        rewardName: rewardName,
        empId: empId,
        empName: empName,
        department: department,
        branch: branch,
        uid: uid
      });
    }
  }
  return list;
}

/**
 * บันทึก / แก้ไข / เพิ่มรางวัล (Create & Update)
 * - ดึงข้อมูลผู้ลงทะเบียนจาก Sheet "Register"
 * - บันทึกข้อมูลผู้รับรางวัลในคอลัมน์ A:F (A=ชื่อรางวัล, B=รหัสพนักงาน, C=ชื่อ, D=แผนก, E=สาขา, F=uid)
 * - ส่ง LINE Flex Message แจ้งเตือน
 */
function saveRewardRecord(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการ (อนุญาตเฉพาะแอดมินเท่านั้น)' };
  }
  const lock = LockService.getScriptLock();
  let lockHeld = false;
  try {
    lock.waitLock(10000);
    lockHeld = true;

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const rewardSheet = getRewardSheet(ss);
    if (!rewardSheet) {
      return { status: 'error', message: 'ไม่พบแผ่นงานรางวัล (Sheet gift)' };
    }

    let rowIndex = payload.rowIndex ? parseInt(payload.rowIndex, 10) : 0;
    const rewardName = String(payload.rewardName || '').trim();
    const empId = String(payload.empId || '').trim().replace(/\.0$/, '');
    let empName = '';
    let department = '';
    let branch = '';
    let uid = '';
    let pictureUrl = '';

    if (!rewardName) {
      return { status: 'error', message: 'กรุณาระบุชื่อรางวัล' };
    }

    // ดึงข้อมูลผู้ได้รับรางวัลจาก Sheet "Register" เสมอเมื่อมีการระบุรหัสพนักงาน
    if (empId) {
      const { employeesMap } = getRegisteredEmployeesFromRegisterSheet(ss);
      const regEmp = employeesMap[empId];
      if (!regEmp) {
        return {
          status: 'error',
          message: `ไม่พบรหัสพนักงาน ${empId} ใน Sheet Register (ระบบอนุญาตเฉพาะผู้ที่ลงทะเบียนใน Sheet Register แล้วเท่านั้น)`
        };
      }
      empName = regEmp.empName || '';
      department = regEmp.department || '';
      branch = regEmp.branch || '';
      uid = regEmp.uid || '';
      pictureUrl = regEmp.pictureUrl || '';

      if (isExcludedFromRewardDepartment(department)) {
        return {
          status: 'error',
          message: `แผนก "${department}" ไม่มีสิทธิ์รับรางวัล (${empName} รหัส ${empId})`
        };
      }
    }

    // กรณีไม่ได้ระบุ rowIndex มา ให้ค้นหาจากชื่อรางวัลที่ยังไม่มีผู้รับ หรือเพิ่มแถวใหม่ (Create)
    if (!rowIndex || rowIndex < 2) {
      const lastRow = rewardSheet.getLastRow();
      if (lastRow >= 2) {
        const rows = rewardSheet.getRange(2, 1, lastRow - 1, 2).getValues();
        for (let i = 0; i < rows.length; i++) {
          const existingPrize = String(rows[i][0] || '').trim();
          const existingEmpId = String(rows[i][1] || '').trim();
          if (existingPrize === rewardName && !existingEmpId) {
            rowIndex = i + 2;
            break;
          }
        }
      }
      if (!rowIndex || rowIndex < 2) {
        rowIndex = Math.max(2, rewardSheet.getLastRow() + 1);
      }
    }

    // ตรวจสอบว่ารหัสพนักงานนี้เคยได้รับรางวัลไปแล้วหรือไม่ (ป้องกันการรับรางวัลซ้ำ) และแถวรางวัลยังว่างจริง
    if (empId) {
      const lastRow = rewardSheet.getLastRow();
      if (lastRow >= 2) {
        const existingRows = rewardSheet.getRange(2, 1, lastRow - 1, 2).getValues();
        const targetIdx = rowIndex - 2;
        if (targetIdx >= 0 && targetIdx < existingRows.length) {
          const currentOwnerId = String(existingRows[targetIdx][1] || '').trim().replace(/\.0$/, '');
          if (currentOwnerId) {
            return {
              status: 'error',
              message: `รางวัล "${rewardName}" แถวที่ ${rowIndex} ถูกแจกให้รหัส ${currentOwnerId} ไปแล้ว (กรุณารีเฟรชข้อมูล)`
            };
          }
        }
        for (let i = 0; i < existingRows.length; i++) {
          const checkRowIndex = i + 2;
          if (checkRowIndex !== rowIndex) {
            const checkEmpId = String(existingRows[i][1] || '').trim().replace(/\.0$/, '');
            if (checkEmpId === empId) {
              const checkRewardName = String(existingRows[i][0] || '').trim();
              return {
                status: 'error',
                message: `รหัสนี้ได้รับรางวัลไปแล้ว โปรดตรวจสอบใหม่อีกครั้ง (ได้รับรางวัล: ${checkRewardName})`
              };
            }
          }
        }
      }
    }

    // บันทึกค่าลงในแถวที่กำหนด (A=ชื่อรางวัล, B=รหัสพนักงาน, C=ชื่อ, D=แผนก, E=สาขา, F=uid)
    rewardSheet.getRange(rowIndex, 1, 1, 6).setValues([[
      rewardName,
      empId,
      empName,
      department,
      branch,
      uid
    ]]);
    SpreadsheetApp.flush();

    // ปล่อย Lock ก่อนยิง LINE Push API เพื่อไม่ให้บล็อกการลงทะเบียนหรือการควบคุมจอเวที
    lock.releaseLock();
    lockHeld = false;

    // ส่ง Flex Message แจ้งเตือนผ่าน LINE Push API หากผู้รับรางวัลมี LINE UID
    let lineSent = false;
    let lineMessageStatus = '';

    if (empId && uid && uid !== 'TEST_USER') {
      try {
        const pushRes = pushRewardFlexMessage(uid, {
          rewardName: rewardName,
          empId: empId,
          empName: empName,
          department: department,
          branch: branch,
          pictureUrl: pictureUrl
        });
        lineSent = pushRes.success;
        lineMessageStatus = pushRes.message;
      } catch (pushErr) {
        lineMessageStatus = pushErr.message;
      }
    } else if (empId && !uid) {
      lineMessageStatus = 'บันทึกสำเร็จ (พนักงานยังไม่มี LINE UID ในหน้า Register จึงไม่ได้ส่งแจ้งเตือนเข้า LINE)';
    }

    return {
      status: 'success',
      message: 'บันทึกข้อมูลรางวัลสำเร็จ',
      lineSent: lineSent,
      lineMessageStatus: lineMessageStatus,
      data: {
        rowIndex: rowIndex,
        rewardName: rewardName,
        empId: empId,
        empName: empName,
        department: department,
        branch: branch,
        uid: uid
      }
    };
  } catch (err) {
    console.error('Error in saveRewardRecord:', err);
    return { status: 'error', message: err.message };
  } finally {
    if (lockHeld) lock.releaseLock();
  }
}

/**
 * บันทึกผู้ได้รับรางวัลแบบหลายรายการพร้อมกันในครั้งเดียว (Batch Lucky Draw)
 * - ใช้ LockService ล็อกรอบเดียว ตรวจสอบสิทธิ์ใน Register และกันซ้ำทั้งผู้รับและแถวรางวัล
 * - ส่ง LINE Flex Message แจ้งเตือนผู้ได้รับรางวัลทุกคนที่มี LINE UID เหมือนบันทึกทีละรายการ
 */
function saveBatchRewards(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการ (อนุญาตเฉพาะแอดมินเท่านั้น)' };
  }
  const lock = LockService.getScriptLock();
  let lockHeld = false;
  try {
    lock.waitLock(15000);
    lockHeld = true;

    let items = [];
    if (Array.isArray(payload.items)) {
      items = payload.items;
    } else if (typeof payload.items === 'string' && payload.items.trim()) {
      items = JSON.parse(payload.items);
    }

    if (!items || items.length === 0) {
      return { status: 'error', message: 'ไม่มีรายการรางวัลสำหรับบันทึก' };
    }

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const rewardSheet = getRewardSheet(ss);
    if (!rewardSheet) {
      return { status: 'error', message: 'ไม่พบแผ่นงานรางวัล (Sheet gift)' };
    }

    const { employeesMap } = getRegisteredEmployeesFromRegisterSheet(ss);
    const lastRow = rewardSheet.getLastRow();
    const assignedEmpToReward = {};
    const existingRowMap = {};

    if (lastRow >= 2) {
      const existingRows = rewardSheet.getRange(2, 1, lastRow - 1, 2).getValues();
      for (let i = 0; i < existingRows.length; i++) {
        const rNum = i + 2;
        const rName = String(existingRows[i][0] || '').trim();
        const eId = String(existingRows[i][1] || '').trim().replace(/\.0$/, '');
        existingRowMap[rNum] = { rewardName: rName, empId: eId };
        if (eId && !assignedEmpToReward[eId]) {
          assignedEmpToReward[eId] = rName || `แถว ${rNum}`;
        }
      }
    }

    const results = [];
    const committed = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i] || {};
      const rowIdx = parseInt(item.rowIndex, 10);
      const reqRewardName = String(item.rewardName || '').trim();
      const empId = String(item.empId || '').trim().replace(/\.0$/, '');

      if (!rowIdx || rowIdx < 2) {
        results.push({ rowIndex: rowIdx, rewardName: reqRewardName, empId: empId, status: 'error', message: 'rowIndex ไม่ถูกต้อง' });
        continue;
      }

      const existingRow = existingRowMap[rowIdx];
      if (existingRow && existingRow.empId) {
        results.push({
          rowIndex: rowIdx,
          rewardName: reqRewardName || existingRow.rewardName,
          empId: empId,
          status: 'error',
          message: `รางวัล "${reqRewardName || existingRow.rewardName}" ถูกแจกให้รหัส ${existingRow.empId} ไปแล้ว`
        });
        continue;
      }

      const finalRewardName = reqRewardName || (existingRow ? existingRow.rewardName : '');
      if (!finalRewardName || !empId) {
        results.push({ rowIndex: rowIdx, rewardName: finalRewardName, empId: empId, status: 'error', message: 'ข้อมูลรางวัลหรือรหัสพนักงานไม่ครบ' });
        continue;
      }

      const regEmp = employeesMap[empId];
      if (!regEmp) {
        results.push({
          rowIndex: rowIdx,
          rewardName: finalRewardName,
          empId: empId,
          status: 'error',
          message: `ไม่พบรหัสพนักงาน ${empId} ใน Sheet Register`
        });
        continue;
      }

      if (isExcludedFromRewardDepartment(regEmp.department)) {
        results.push({
          rowIndex: rowIdx,
          rewardName: finalRewardName,
          empId: empId,
          status: 'error',
          message: `แผนก "${regEmp.department}" ไม่มีสิทธิ์รับรางวัล`
        });
        continue;
      }

      if (assignedEmpToReward[empId]) {
        results.push({
          rowIndex: rowIdx,
          rewardName: finalRewardName,
          empId: empId,
          empName: regEmp.empName || '',
          status: 'error',
          message: `รหัส ${empId} ได้รับรางวัล "${assignedEmpToReward[empId]}" ไปแล้ว`
        });
        continue;
      }

      const empName = regEmp.empName || '';
      const department = regEmp.department || '';
      const branch = regEmp.branch || '';
      const uid = regEmp.uid || '';
      const pictureUrl = regEmp.pictureUrl || '';

      rewardSheet.getRange(rowIdx, 1, 1, 6).setValues([[
        finalRewardName,
        empId,
        empName,
        department,
        branch,
        uid
      ]]);

      assignedEmpToReward[empId] = finalRewardName;
      existingRowMap[rowIdx] = { rewardName: finalRewardName, empId: empId };

      const recordObj = {
        rowIndex: rowIdx,
        rewardName: finalRewardName,
        empId: empId,
        empName: empName,
        department: department,
        branch: branch,
        uid: uid,
        pictureUrl: pictureUrl,
        status: 'success',
        lineSent: false,
        lineMessageStatus: ''
      };
      committed.push(recordObj);
      results.push(recordObj);
    }

    if (committed.length > 0) {
      SpreadsheetApp.flush();
    }

    // ปล่อย Lock ทันทีหลังเขียนลง Sheet เสร็จ ก่อนเริ่ม Loop ยิง LINE Push API หลายรายการ
    lock.releaseLock();
    lockHeld = false;

    let lineSentCount = 0;
    let permissionRequired = false;

    for (let j = 0; j < committed.length; j++) {
      const rec = committed[j];
      if (rec.uid && rec.uid !== 'TEST_USER') {
        try {
          const pushRes = pushRewardFlexMessage(rec.uid, {
            rewardName: rec.rewardName,
            empId: rec.empId,
            empName: rec.empName,
            department: rec.department,
            branch: rec.branch,
            pictureUrl: rec.pictureUrl
          });
          rec.lineSent = Boolean(pushRes.success);
          rec.lineMessageStatus = pushRes.message || '';
          if (rec.lineSent) {
            lineSentCount++;
          } else if (String(rec.lineMessageStatus).indexOf('script.external_request') !== -1 || String(rec.lineMessageStatus).indexOf('UrlFetchApp') !== -1) {
            permissionRequired = true;
          }
        } catch (pushErr) {
          rec.lineMessageStatus = pushErr.message || String(pushErr);
          if (rec.lineMessageStatus.indexOf('script.external_request') !== -1 || rec.lineMessageStatus.indexOf('UrlFetchApp') !== -1) {
            permissionRequired = true;
          }
        }
      } else {
        rec.lineMessageStatus = 'ไม่มี LINE UID ในหน้า Register (บันทึกลง Sheet สำเร็จ)';
      }
    }

    const errorCount = results.filter(r => r.status !== 'success').length;
    return {
      status: committed.length > 0 ? 'success' : 'error',
      message: committed.length > 0
        ? `บันทึกรางวัลสำเร็จ ${committed.length} รายการ (ส่งแจ้งเตือน LINE ${lineSentCount} คน)`
        : ((results[0] && results[0].message) || 'ไม่สามารถบันทึกรางวัลได้'),
      savedCount: committed.length,
      errorCount: errorCount,
      lineSentCount: lineSentCount,
      permissionRequired: permissionRequired,
      results: results
    };
  } catch (err) {
    console.error('Error in saveBatchRewards:', err);
    return { status: 'error', message: err.message };
  } finally {
    if (lockHeld) lock.releaseLock();
  }
}

/**
 * ลบข้อมูลผู้รับรางวัล (ล้างค่าผู้รับรางวัลในคอลัมน์ B:F หรือลบทั้งแถว)
 */
function deleteRewardRecord(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการ (อนุญาตเฉพาะแอดมินเท่านั้น)' };
  }
  const lock = LockService.getScriptLock();
  let lockHeld = false;
  try {
    lock.waitLock(10000);
    lockHeld = true;
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const rewardSheet = getRewardSheet(ss);
    if (!rewardSheet) {
      return { status: 'error', message: 'ไม่พบแผ่นงานรางวัล' };
    }

    const rowIndex = parseInt(payload.rowIndex, 10);
    if (!rowIndex || rowIndex < 2) {
      return { status: 'error', message: 'ระบุแถวที่ต้องการลบไม่ถูกต้อง' };
    }

    const mode = String(payload.mode || 'clear');
    if (mode === 'removeRow') {
      rewardSheet.deleteRow(rowIndex);
      return { status: 'success', message: 'ลบรายการรางวัลเรียบร้อยแล้ว', rowIndex: rowIndex };
    } else {
      // ล้างเฉพาะข้อมูลพนักงานในคอลัมน์ B:F (คงชื่อรางวัล A ไว้)
      rewardSheet.getRange(rowIndex, 2, 1, 5).clearContent();
      const rewardName = String(rewardSheet.getRange(rowIndex, 1).getValue() || '').trim();
      return {
        status: 'success',
        message: 'ล้างข้อมูลผู้รับรางวัลเรียบร้อยแล้ว',
        data: {
          rowIndex: rowIndex,
          rewardName: rewardName,
          empId: '',
          empName: '',
          department: '',
          branch: '',
          uid: ''
        }
      };
    }
  } catch (err) {
    return { status: 'error', message: err.message };
  } finally {
    if (lockHeld) lock.releaseLock();
  }
}

/**
 * ส่ง LINE แจ้งเตือนซ้ำให้กับผู้โชคดีที่ระบุแถวใน Sheet รางวัล (เฉพาะแอดมิน)
 */
function resendRewardLineNotification(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการ (อนุญาตเฉพาะแอดมินเท่านั้น)' };
  }

  const lock = LockService.getScriptLock();
  let lockHeld = false;
  try {
    lock.waitLock(10000);
    lockHeld = true;
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const rewardSheet = getRewardSheet(ss);
    if (!rewardSheet) {
      return { status: 'error', message: 'ไม่พบแผ่นงานรางวัล' };
    }

    const rowIndex = parseInt(payload.rowIndex, 10);
    const lastRow = rewardSheet.getLastRow();
    if (!rowIndex || rowIndex < 2 || rowIndex > lastRow) {
      return { status: 'error', message: 'ระบุแถวรายการรางวัลไม่ถูกต้อง' };
    }

    const rowValues = rewardSheet.getRange(rowIndex, 1, 1, 6).getValues()[0];
    const rewardName = String(rowValues[0] || '').trim();
    const empId = String(rowValues[1] || '').trim().replace(/\.0$/, '');
    let empName = String(rowValues[2] || '').trim();
    let department = String(rowValues[3] || '').trim();
    let branch = String(rowValues[4] || '').trim();
    let uid = String(rowValues[5] || '').trim();

    if (!empId) {
      return { status: 'error', message: 'รายการนี้ยังไม่มีผู้รับรางวัล' };
    }

    let pictureUrl = '';
    let uidUpdated = false;
    try {
      const { employeesMap } = getRegisteredEmployeesFromRegisterSheet(ss);
      const regEmp = employeesMap && employeesMap[empId];
      if (regEmp) {
        if (!empName) empName = regEmp.empName || '';
        if (!department) department = regEmp.department || '';
        if (!branch) branch = regEmp.branch || '';
        if ((!uid || uid === 'TEST_USER') && regEmp.uid && regEmp.uid !== 'TEST_USER') {
          uid = regEmp.uid;
          rewardSheet.getRange(rowIndex, 6).setValue(uid);
          uidUpdated = true;
        }
        pictureUrl = regEmp.pictureUrl || '';
      }
    } catch (lookupErr) {
      console.warn('resendRewardLineNotification lookup warning:', lookupErr);
    }

    if (!uid || uid === 'TEST_USER') {
      return { status: 'error', message: 'ไม่พบ LINE UID ของผู้รับรางวัลรายนี้ (ไม่สามารถส่งแจ้งเตือน LINE ได้)' };
    }

    // ปล่อย Lock ก่อนยิง LINE Push API เพื่อไม่ให้ถือค้างข้าม Network Call
    if (uidUpdated) {
      SpreadsheetApp.flush();
    }
    lock.releaseLock();
    lockHeld = false;

    const pushRes = pushRewardFlexMessage(uid, {
      rewardName: rewardName,
      empId: empId,
      empName: empName,
      department: department,
      branch: branch,
      pictureUrl: pictureUrl
    });

    if (pushRes && pushRes.success) {
      return {
        status: 'success',
        lineSent: true,
        message: 'ส่งแจ้งเตือน LINE ซ้ำเรียบร้อยแล้ว',
        data: { rowIndex: rowIndex, rewardName: rewardName, empId: empId, empName: empName, uid: uid }
      };
    }

    return {
      status: 'error',
      lineSent: false,
      message: 'ส่งแจ้งเตือนไม่สำเร็จ: ' + ((pushRes && pushRes.message) || 'Unknown error'),
      data: { rowIndex: rowIndex, rewardName: rewardName, empId: empId, empName: empName, uid: uid }
    };
  } catch (err) {
    console.error('Error in resendRewardLineNotification:', err);
    return { status: 'error', message: err.message };
  } finally {
    if (lockHeld) lock.releaseLock();
  }
}

const STAGE_DISPLAY_PROP_KEY = 'STAGE_DISPLAY_STATE';
const STAGE_DISPLAY_CACHE_KEY = 'STAGE_DISPLAY_STATE_CACHE';

function getDefaultStageDisplayState() {
  return {
    version: 0,
    clientId: '',
    clientSeq: 0,
    serverSeq: 0,
    mode: 'standby',
    prizeLabel: '',
    rollingNames: [],
    winners: [],
    activeIndex: 0,
    celebrateNonce: 0,
    stats: null,
    updatedAt: 0
  };
}

/**
 * ดึงสถานะล่าสุดสำหรับหน้าจอใหญ่ประกาศผลรางวัล (stage.html) จาก CacheService อย่างรวดเร็ว
 */
function getStageDisplayState() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(STAGE_DISPLAY_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed === 'object') {
        return {
          status: 'success',
          state: parsed,
          serverTime: Date.now()
        };
      }
    }

    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(STAGE_DISPLAY_PROP_KEY);
    if (raw) {
      const parsedProp = JSON.parse(raw);
      if (parsedProp && typeof parsedProp === 'object') {
        try {
          cache.put(STAGE_DISPLAY_CACHE_KEY, raw, 600);
        } catch (cacheErr) {}
        return {
          status: 'success',
          state: parsedProp,
          serverTime: Date.now()
        };
      }
    }
  } catch (err) {
    console.warn('getStageDisplayState warning:', err);
  }

  return {
    status: 'success',
    state: getDefaultStageDisplayState(),
    serverTime: Date.now()
  };
}

/**
 * อัปเดตสถานะหน้าจอใหญ่ประกาศผลรางวัลจากหลังเวที (เฉพาะแอดมินเท่านั้น + Lock & Stale-Write Guard)
 */
function setStageDisplayState(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'error', message: 'ไม่มีสิทธิ์ดำเนินการ (อนุญาตเฉพาะแอดมินเท่านั้น)' };
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    let rawState = payload && payload.state ? payload.state : {};
    if (typeof rawState === 'string') {
      rawState = JSON.parse(rawState);
    }
    if (!rawState || typeof rawState !== 'object') {
      rawState = {};
    }

    const props = PropertiesService.getScriptProperties();
    let existing = null;
    try {
      const existingRaw = props.getProperty(STAGE_DISPLAY_PROP_KEY);
      if (existingRaw) existing = JSON.parse(existingRaw);
    } catch (readErr) {}

    const incomingClientId = String(rawState.clientId || '').trim().slice(0, 64);
    const incomingClientSeq = Math.max(0, parseInt(rawState.clientSeq, 10) || 0);

    // ป้องกัน Request เก่าที่ถึงช้ากว่าเขียนทับคำสั่งใหม่ (Out-of-order Race Condition)
    if (
      existing &&
      existing.clientId &&
      incomingClientId &&
      existing.clientId === incomingClientId &&
      incomingClientSeq > 0 &&
      incomingClientSeq < (Number(existing.clientSeq) || 0)
    ) {
      return {
        status: 'success',
        staleIgnored: true,
        state: existing,
        serverTime: Date.now()
      };
    }

    const rawMode = String(rawState.mode || 'standby').trim().toLowerCase();
    const mode = (rawMode === 'rolling' || rawMode === 'winner') ? rawMode : 'standby';

    const rollingNames = Array.isArray(rawState.rollingNames)
      ? rawState.rollingNames
          .slice(0, 40)
          .map(name => String(name || '').trim().slice(0, 60))
          .filter(Boolean)
      : [];

    const winners = Array.isArray(rawState.winners)
      ? rawState.winners.slice(0, 50).map(w => ({
          rewardName: String((w && w.rewardName) || '-').trim().slice(0, 120),
          empId: String((w && w.empId) || '-').trim().slice(0, 40),
          empName: String((w && w.empName) || '-').trim().slice(0, 100),
          department: String((w && w.department) || '-').trim().slice(0, 100),
          branch: String((w && w.branch) || '-').trim().slice(0, 80),
          displayName: String((w && w.displayName) || '').trim().slice(0, 80),
          pictureUrl: String((w && w.pictureUrl) || '').trim().slice(0, 500),
          statusText: String((w && w.statusText) || '').trim().slice(0, 80),
          statusTone: String((w && w.statusTone) || 'saved').trim().slice(0, 20)
        }))
      : [];

    const maxIdx = Math.max(0, winners.length - 1);
    const parsedIdx = parseInt(rawState.activeIndex, 10);
    const activeIndex = isNaN(parsedIdx) ? 0 : Math.max(0, Math.min(parsedIdx, maxIdx));

    let stats = null;
    if (rawState.stats && typeof rawState.stats === 'object') {
      stats = {
        eligibleCount: Number(rawState.stats.eligibleCount) || 0,
        remainingPrizes: Number(rawState.stats.remainingPrizes) || 0,
        assignedPrizes: Number(rawState.stats.assignedPrizes) || 0
      };
    }

    const now = Date.now();
    const parsedVer = Number(rawState.version);
    const serverSeq = (Number(existing && existing.serverSeq) || 0) + 1;

    const cleanState = {
      version: (parsedVer > 0) ? parsedVer : now,
      clientId: incomingClientId,
      clientSeq: incomingClientSeq,
      serverSeq: serverSeq,
      mode: mode,
      prizeLabel: String(rawState.prizeLabel || '').trim().slice(0, 120),
      rollingNames: rollingNames,
      winners: winners,
      activeIndex: activeIndex,
      celebrateNonce: Math.max(0, parseInt(rawState.celebrateNonce, 10) || 0),
      stats: stats,
      updatedAt: now
    };

    const jsonStr = JSON.stringify(cleanState);
    props.setProperty(STAGE_DISPLAY_PROP_KEY, jsonStr);
    try {
      CacheService.getScriptCache().put(STAGE_DISPLAY_CACHE_KEY, jsonStr, 600);
    } catch (cacheErr) {}

    return {
      status: 'success',
      staleIgnored: false,
      state: cleanState,
      serverTime: now
    };
  } catch (err) {
    console.error('Error in setStageDisplayState:', err);
    return { status: 'error', message: err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ส่ง LINE Push Message (Flex Message) แจ้งเตือนผู้โชคดีที่ได้รับรางวัล
 */
function pushRewardFlexMessage(uid, info) {
  const token = getLineBotAccessToken();

  const nowStr = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const flexMsg = buildChristmasGlassFlexMessage({
    senderKey: 'santa',
    altText: `🎉 ขอแสดงความยินดี! คุณได้รับรางวัล: ${info.rewardName}`,
    bgImageUrl: 'https://cmparty.vercel.app/assets/flex-giftbox.jpg',
    badgeText: 'LUCKY DRAW WINNER',
    title: 'ขอแสดงความยินดีด้วยครับ!',
    subtitle: 'คุณคือผู้โชคดีได้รับรางวัลในงานเลี้ยง',
    glassCardContents: [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0000004D',
        borderColor: '#FBBF2499',
        borderWidth: '2px',
        cornerRadius: '14px',
        paddingAll: '14px',
        alignItems: 'center',
        spacing: 'xs',
        contents: [
          { type: 'text', text: 'รางวัลที่ได้รับ', color: '#FDE68A', size: 'xs', weight: 'bold' },
          { type: 'text', text: info.rewardName || '-', color: '#FFFFFF', size: 'lg', weight: 'bold', align: 'center', wrap: true }
        ]
      },
      { type: 'separator', color: '#FFFFFF33' },
      {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          buildFlexInfoRow('รหัสพนักงาน', info.empId, '#FFFFFF', 'sm', 'bold'),
          buildFlexInfoRow('ชื่อ - สกุล', info.empName, '#FFFFFF', 'sm', 'bold'),
          buildFlexInfoRow('แผนก', info.department, '#F3F4F6', 'xs'),
          buildFlexInfoRow('สาขา', info.branch, '#86EFAC', 'xs', 'bold')
        ]
      }
    ],
    footerContents: [
      {
        type: 'text',
        text: 'กรุณาแสดงข้อความนี้เพื่อติดต่อรับรางวัลกับเจ้าหน้าที่',
        color: '#FEF08A',
        size: 'xs',
        weight: 'bold',
        align: 'center',
        wrap: true
      },
      {
        type: 'text',
        text: 'เวลาประกาศผล: ' + nowStr,
        color: '#86EFAC',
        size: 'xxs',
        align: 'center',
        margin: 'xs'
      }
    ]
  });

  const url = 'https://api.line.me/v2/bot/message/push';
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token
    },
    payload: JSON.stringify({
      to: uid,
      messages: [flexMsg]
    }),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  if (code === 200) {
    return { success: true, message: 'ส่ง Flex Message แจ้งเตือนทาง LINE สำเร็จ' };
  }
  return { success: false, message: 'LINE Push Error (' + code + '): ' + response.getContentText() };
}

// ==========================================
// 10. ระบบ LINE Bot Webhook (ย้ายมารวมจาก รหัส.js + เพิ่มคำสั่ง "ตรวจสอบรางวัล" ค้นหาจาก Sheet gift B2:B)
// ==========================================
function handleLineWebhookPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ status: 'no postData' });
    }

    const payload = JSON.parse(e.postData.contents);
    const events = payload.events || [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const webhookEventId = String(event.webhookEventId || '').trim();
      if (webhookEventId) {
        try {
          const evtCache = CacheService.getScriptCache();
          const evtKey = 'WH_EVT_' + webhookEventId;
          if (evtCache.get(evtKey) === '1') {
            continue;
          }
          evtCache.put(evtKey, '1', 120);
        } catch (dedupErr) {}
      }

      // กรณีบล็อกหรือเลิกติดตาม (unfollow) — ไม่มี replyToken จึงต้องจัดการก่อนตรวจ replyToken
      if (event.type === 'unfollow') {
        const unfollowUserId = event.source && event.source.userId;
        if (unfollowUserId) {
          try {
            CacheService.getScriptCache().remove('IS_FRIEND_' + unfollowUserId);
          } catch (e) {}
        }
        continue;
      }

      const replyToken = event.replyToken;

      // ข้ามกรณี Verify Webhook ของ LINE (replyToken เป็น 0000...)
      if (!replyToken || replyToken === '00000000000000000000000000000000') {
        continue;
      }

      // 1) กรณีเพิ่มเพื่อนครั้งแรก (หรือปลดบล็อก) -> ส่ง Welcome Flex Message พร้อมโปรไฟล์
      if (event.type === 'follow') {
        const followUserId = event.source && event.source.userId;
        if (followUserId) {
          try {
            CacheService.getScriptCache().put('IS_FRIEND_' + followUserId, '1', 600);
          } catch (e) {}
        }
        handleFollowEvent(event);
      }

      // 2) กรณีส่งข้อความ (message) -> ต้องตรวจสอบก่อนว่าผู้ใช้ได้กดเพิ่มเพื่อนกับ LINE Bot แล้วหรือไม่
      else if (event.type === 'message') {
        const msgUserId = event.source && event.source.userId;

        // หากผู้ใช้ยังไม่ได้กดเพิ่มเพื่อนกับ LINE Official Account (ทักแชทเข้ามาก่อน) -> บล็อกการใช้งานและแจ้งเตือนให้เพิ่มเพื่อนก่อน
        if (msgUserId && !isUserFriendWithBot(msgUserId)) {
          replyMustAddFriendMessage(replyToken);
          continue;
        }

        // 2.1) กรณีส่งข้อความประเภท รูปภาพ (image) -> อัปโหลดขึ้น Drive และส่งข้อความตอบกลับ
        if (event.message && event.message.type === 'image') {
          handleImageMessage(event);
        }

        // 2.2) กรณีส่งข้อความตัวอักษร (text) -> รองรับคำสั่ง "ตรวจสอบรางวัล" และรับรหัสพนักงานเพื่อเช็คจาก Sheet "gift" (B2:B)
        else if (event.message && event.message.type === 'text') {
          handleTextMessage(event);
        }
      }
    }

    return createJsonResponse({ status: 'ok' });
  } catch (error) {
    console.error('Error in handleLineWebhookPost:', error);
    return createJsonResponse({ status: 'error', message: error.toString() });
  }
}

/**
 * จัดการข้อความ Text จาก LINE Chat:
 * - เมื่อพิมพ์/กด "ดูรูปกิจกรรม" -> บอทส่ง Flex Message พร้อมปุ่ม "ดูรูปกิจกรรมในงาน" พาไปยังหน้าแกลเลอรี
 * - เมื่อพิมพ์ "ตรวจสอบรางวัล" -> บอทตอบกลับ "กรุณาพิมพ์รหัสพนักงานของท่าน" และบันทึกสถานะรอรหัสพนักงาน
 * - เมื่อพิมพ์รหัสพนักงานเข้ามา -> บอทค้นหารหัสพนักงานใน Sheet "gift" คอลัมน์ B2:B แล้วแจ้งผลการได้รับรางวัล
 */
const CHAT_WAIT_STATES_PROP_KEY = 'CHAT_WAIT_STATES_V1';
const CHAT_WAIT_MAX_AGE_MS = 15 * 60 * 1000;

function readChatWaitStatesMap(props) {
  try {
    const raw = props.getProperty(CHAT_WAIT_STATES_PROP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    return {};
  }
}

function pruneAndSaveChatWaitStatesMap(props, map, nowMs) {
  const clean = {};
  const keys = Object.keys(map || {});
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const ts = Number(map[k] || 0);
    if (ts > 0 && (nowMs - ts) < CHAT_WAIT_MAX_AGE_MS) {
      clean[k] = ts;
    }
  }
  const cleanKeys = Object.keys(clean);
  if (cleanKeys.length === 0) {
    props.deleteProperty(CHAT_WAIT_STATES_PROP_KEY);
  } else {
    props.setProperty(CHAT_WAIT_STATES_PROP_KEY, JSON.stringify(clean));
  }
}

function setChatWaitState(cache, props, key, cacheTtlSec) {
  const nowMs = Date.now();
  try {
    cache.put(key, 'WAITING', cacheTtlSec);
  } catch (cErr) {}
  try {
    const map = readChatWaitStatesMap(props);
    map[key] = nowMs;
    pruneAndSaveChatWaitStatesMap(props, map, nowMs);
  } catch (pErr) {}
}

function hasChatWaitState(cache, props, key, maxAgeMs) {
  try {
    if (cache.get(key) === 'WAITING') return true;
  } catch (cErr) {}
  const nowMs = Date.now();
  try {
    const map = readChatWaitStatesMap(props);
    const ts = Number(map[key] || 0);
    if (ts > 0 && (nowMs - ts) < maxAgeMs) {
      return true;
    }
    const legacyTs = props.getProperty(key);
    if (legacyTs && (nowMs - Number(legacyTs) < maxAgeMs)) {
      return true;
    }
  } catch (pErr) {}
  return false;
}

function clearChatWaitState(cache, props, key) {
  try {
    cache.remove(key);
  } catch (cErr) {}
  try {
    const map = readChatWaitStatesMap(props);
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      delete map[key];
      pruneAndSaveChatWaitStatesMap(props, map, Date.now());
    }
    props.deleteProperty(key);
  } catch (pErr) {}
}

function handleTextMessage(event) {
  const replyToken = event.replyToken;
  const rawUserId = (event.source && event.source.userId) ? String(event.source.userId).trim() : '';
  const userId = (event.source && (event.source.userId || event.source.groupId || event.source.roomId)) || 'anon';
  const rawText = String((event.message && event.message.text) || '').trim();
  const normalizedCommand = rawText.replace(/\s+/g, '');
  const lowerCommand = normalizedCommand.toLowerCase();

  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  const stateKey = 'WAIT_REWARD_EMP_' + userId;
  const wishStateKey = 'WAIT_WISH_TEXT_' + userId;
  const userQuoteToken = (event.message && event.message.quoteToken) ? String(event.message.quoteToken).trim() : '';

  const clearRewardWaitState = () => clearChatWaitState(cache, props, stateKey);
  const clearWishWaitState = () => clearChatWaitState(cache, props, wishStateKey);
  const clearAllWaitStates = () => {
    clearRewardWaitState();
    clearWishWaitState();
  };

  // 0. คำสั่งพิเศษสำหรับแอดมิน: ติดตั้ง/ปิด LINE Rich Menu 6 ช่อง ผ่านแชท
  if (rawUserId && isAdminUid(rawUserId)) {
    if (normalizedCommand === 'เปิดริชเมนู' || lowerCommand === '/richmenuon' || lowerCommand === 'richmenuon') {
      clearAllWaitStates();
      startLoadingAnimation(rawUserId, 15);
      const rmRes = setupLineRichMenu();
      const replyMsg = rmRes && rmRes.status === 'success'
        ? `🎄 ${rmRes.message}\n(ID: ${rmRes.richMenuId})\nลองกดเปิดแถบเมนูด้านล่างแชทได้เลยค่ะ ✨`
        : `❌ ติดตั้ง Rich Menu ไม่สำเร็จ: ${(rmRes && rmRes.message) || 'เกิดข้อผิดพลาด'}`;
      replyLineMessage(replyToken, [buildQuotedRewardTextMessage(replyMsg, userQuoteToken, null, 'elf')]);
      return;
    }
    if (normalizedCommand === 'ปิดริชเมนู' || lowerCommand === '/richmenuoff' || lowerCommand === 'richmenuoff') {
      clearAllWaitStates();
      startLoadingAnimation(rawUserId, 10);
      const rmRes = clearLineRichMenu();
      const replyMsg = rmRes && rmRes.status === 'success'
        ? `🗑️ ${rmRes.message}\n(ลบออกจาก API แล้ว ${rmRes.deletedCount || 0} รายการ)`
        : `❌ ปิด Rich Menu ไม่สำเร็จ: ${(rmRes && rmRes.message) || 'เกิดข้อผิดพลาด'}`;
      replyLineMessage(replyToken, [buildQuotedRewardTextMessage(replyMsg, userQuoteToken, null, 'elf')]);
      return;
    }
    if (normalizedCommand === 'เช็คริชเมนู' || lowerCommand === '/richmenustatus' || lowerCommand === 'richmenustatus') {
      clearAllWaitStates();
      startLoadingAnimation(rawUserId, 5);
      const info = inspectLineRichMenus();
      let replyMsg = '';
      if (!info || info.status !== 'success') {
        replyMsg = `❌ ตรวจสอบ Rich Menu ไม่สำเร็จ: ${(info && info.message) || 'เกิดข้อผิดพลาด'}`;
      } else {
        const lines = [
          '📋 ผลการตรวจสอบ LINE Rich Menu ปัจจุบัน',
          `• ${info.sourceSummary}`,
          `• Default API Menu ID: ${info.defaultRichMenuId || 'ไม่มี (ใช้จาก manager.line.biz)'}`,
          `• เมนูที่สร้างผ่าน API ทั้งหมด: ${info.apiMenuCount} รายการ`
        ];
        if (info.apiMenus && info.apiMenus.length > 0) {
          info.apiMenus.forEach((m, idx) => {
            const labels = (m.areas || []).map(a => (a.action && (a.action.label || a.action.text || a.action.uri)) || '-').join(', ');
            lines.push(`  ${idx + 1}) ${m.name || '-'} (${m.richMenuId}) [${labels}]`);
          });
        }
        replyMsg = lines.join('\n');
      }
      replyLineMessage(replyToken, [buildQuotedRewardTextMessage(replyMsg, userQuoteToken, null, 'elf')]);
      return;
    }
  }

  // 1. หากผู้ใช้กดปุ่มหรือพิมพ์ขอดูรูป/ภาพกิจกรรมในงาน
  const galleryKeywords = [
    'ภาพกิจกรรมในงาน',
    'ดูภาพกิจกรรมในงาน',
    'ดูรูปกิจกรรม',
    'ดูรูปกิจกรรมในงาน',
    'ดูภาพกิจกรรม',
    'รูปกิจกรรม',
    'ภาพกิจกรรม',
    'ดูรูป',
    'แกลเลอรี',
    'ดูแกลเลอรี',
    'gallery'
  ];
  const isGalleryRequest =
    galleryKeywords.indexOf(lowerCommand) !== -1 ||
    lowerCommand.indexOf('ภาพกิจกรรม') !== -1 ||
    lowerCommand.indexOf('รูปกิจกรรม') !== -1;

  if (isGalleryRequest) {
    clearAllWaitStates();

    if (rawUserId) {
      startLoadingAnimation(rawUserId, 5);
    }

    const galleryFlex = createGalleryFlexMessage();
    replyLineMessage(replyToken, [galleryFlex]);
    return;
  }

  // 2. มินิเกม "เสี่ยงเซียมซีปีใหม่ 2026"
  const fortuneKeywords = [
    'เสี่ยงเซียมซี',
    'เสี่ยงเซียมซีปีใหม่',
    'เซียมซี',
    'คำทำนาย',
    'ดวงปีใหม่',
    'fortune'
  ];
  const isFortuneRequest =
    fortuneKeywords.indexOf(lowerCommand) !== -1 ||
    lowerCommand.indexOf('เซียมซี') !== -1;

  if (isFortuneRequest) {
    clearAllWaitStates();

    if (rawUserId) {
      startLoadingAnimation(rawUserId, 5);
    }

    replyLineMessage(replyToken, [buildNewYearFortuneMessage(userQuoteToken)]);
    return;
  }

  // 3. คำสั่งส่งคำอวยพรขึ้นหัวตุ๊กตาบนจอเวที (Live Party Wishes)
  const wishPromptKeywords = [
    'อวยพร',
    'ส่งคำอวยพร',
    'อวยพรขึ้นจอ',
    'ส่งคำอวยพรขึ้นจอ'
  ];
  if (wishPromptKeywords.indexOf(normalizedCommand) !== -1) {
    clearRewardWaitState();
    setChatWaitState(cache, props, wishStateKey, 300); // รอรับข้อความอวยพร 5 นาที

    if (rawUserId) {
      startLoadingAnimation(rawUserId, 5);
    }

    const wishPromptText =
      '💬 พิมพ์คำอวยพรปีใหม่สั้นๆ (ไม่เกิน 45 ตัวอักษร)\n' +
      'ข้อความจะเด้งขึ้นบนหัวตุ๊กตาของคุณบนจอใหญ่ทันทีค่ะ! ✨\n' +
      '(หรือแตะข้อความด่วนด้านล่างได้เลย)';

    replyLineMessage(replyToken, [
      buildQuotedRewardTextMessage(wishPromptText, userQuoteToken, buildWishPromptQuickReply(), 'elf')
    ]);
    return;
  }

  // รองรับพิมพ์ "อวยพร <ข้อความ>" หรือ "ส่งคำอวยพร <ข้อความ>" ในบรรทัดเดียว
  const inlineWishMatch = rawText.match(/^(?:ส่งคำอวยพรขึ้นจอ|ส่งคำอวยพร|อวยพรขึ้นจอ|อวยพร)\s+([\s\S]+)/i);
  if (inlineWishMatch && inlineWishMatch[1] && inlineWishMatch[1].trim()) {
    clearAllWaitStates();

    if (rawUserId) {
      startLoadingAnimation(rawUserId, 5);
    }

    const saved = saveLivePartyWish(rawUserId, inlineWishMatch[1]);
    if (!saved.success) {
      replyLineMessage(replyToken, [
        buildQuotedRewardTextMessage('❌ ' + saved.message, userQuoteToken, buildWishPromptQuickReply(), 'elf')
      ]);
      return;
    }

    let confirmText =
      `✨ ส่งคำอวยพรขึ้นจอเวทีแล้วค่ะ!\n` +
      `💬 "${saved.wish.text}"\n` +
      `รอดูฟองคำพูดน่ารักๆ บนหัวตุ๊กตา ${saved.wish.displayName} บนจอใหญ่ได้เลย! 🎄`;
    if (!saved.wish.empId) {
      confirmText += '\n(💡 หากยังไม่ได้ลงทะเบียน เข้ากดลงทะเบียนร่วมงานเพื่อให้ตุ๊กตาของคุณปรากฏบนเวทีนะคะ)';
    }

    replyLineMessage(replyToken, [
      buildQuotedRewardTextMessage(confirmText, userQuoteToken, buildWishSentQuickReply(), 'elf')
    ]);
    return;
  }

  // 4. หากผู้ใช้พิมพ์คำว่า "ตรวจสอบรางวัล" (หรือ "ตรวจสอบ รางวัล")
  if (normalizedCommand === 'ตรวจสอบรางวัล') {
    clearWishWaitState();
    setChatWaitState(cache, props, stateKey, 600); // จำสถานะรอรับรหัสพนักงานเป็นเวลา 10 นาที

    if (rawUserId) {
      startLoadingAnimation(rawUserId, 5);
    }

    const myEmpId = findRegisteredEmpIdByUidCached(rawUserId);
    const promptText = myEmpId
      ? '🎁 กรุณาพิมพ์รหัสพนักงานของท่าน\n(หรือแตะปุ่ม Quick Reply ด้านล่างเพื่อตรวจสอบทันทีค่ะ)'
      : '🎁 กรุณาพิมพ์รหัสพนักงานของท่านเพื่อตรวจสอบรางวัลค่ะ';

    replyLineMessage(replyToken, [
      buildQuotedRewardTextMessage(promptText, userQuoteToken, buildRewardPromptQuickReply(myEmpId))
    ]);
    return;
  }

  // ตรวจสอบสถานะรอรับคำอวยพร และรอรับรหัสพนักงาน
  const isWaitingForWish = hasChatWaitState(cache, props, wishStateKey, 10 * 60 * 1000);
  const isWaitingForEmpId = hasChatWaitState(cache, props, stateKey, 15 * 60 * 1000);

  // ปุ่มเมนู / ทักทาย (หากกำลังรอพิมพ์คำอวยพรอยู่ จะไม่ให้คำทักทายเช่น "สวัสดีปีใหม่..." ไปแย่งเปิดเมนู)
  const isInlineRewardCmd = /^ตรวจสอบ\s*รางวัล\s+/i.test(rawText) || (rawText.indexOf('ตรวจสอบรางวัล') === 0 && normalizedCommand !== 'ตรวจสอบรางวัล');
  const strictHelpKeywords = ['เมนู', 'ช่วยเหลือ', 'วิธีใช้', 'ลงทะเบียน', 'ลงทะเบียนร่วมงาน', 'help', 'menu', 'start', '?', 'คำสั่ง'];
  const greetingHelpKeywords = ['แนะนำ', 'สวัสดี', 'ทัก', 'hi', 'hello'];
  const isHelpPrompt = !isInlineRewardCmd && (
    strictHelpKeywords.some(kw => lowerCommand === kw) ||
    (!isWaitingForWish && !isWaitingForEmpId && (
      strictHelpKeywords.some(kw => lowerCommand.indexOf(kw) === 0) ||
      greetingHelpKeywords.some(kw => lowerCommand === kw || lowerCommand.indexOf(kw) === 0)
    ))
  );

  if (isHelpPrompt) {
    clearAllWaitStates();
    const helpQuickReply = {
      items: [
        {
          type: 'action',
          action: {
            type: 'uri',
            label: '📝 ลงทะเบียนร่วมงาน',
            uri: LIFF_REGISTER_URL
          }
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '💬 อวยพรขึ้นจอ',
            text: 'อวยพรขึ้นจอ'
          }
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '🥠 เสี่ยงเซียมซี',
            text: 'เสี่ยงเซียมซี'
          }
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '📸 ภาพกิจกรรมในงาน',
            text: 'ภาพกิจกรรมในงาน'
          }
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '🎁 ตรวจสอบรางวัล',
            text: 'ตรวจสอบรางวัล'
          }
        }
      ]
    };
    const helpFlex = buildPartyMenuFlexMessage(helpQuickReply);
    replyLineMessage(replyToken, [helpFlex]);
    return;
  }

  // 5. หากอยู่ในสถานะรอพิมพ์คำอวยพร (หลังจากกด/พิมพ์ "อวยพร" และไม่ใช่คำสั่ง "ตรวจสอบรางวัล <รหัส>")
  if (isWaitingForWish && !isInlineRewardCmd) {
    clearWishWaitState();

    if (normalizedCommand === 'ยกเลิกอวยพร' || normalizedCommand === 'ยกเลิก') {
      replyLineMessage(replyToken, [
        buildQuotedRewardTextMessage('❌ ยกเลิกการส่งคำอวยพรเรียบร้อยแล้วค่ะ', userQuoteToken, null, 'elf')
      ]);
      return;
    }

    if (rawUserId) {
      startLoadingAnimation(rawUserId, 5);
    }

    const saved = saveLivePartyWish(rawUserId, rawText);
    if (!saved.success) {
      replyLineMessage(replyToken, [
        buildQuotedRewardTextMessage('❌ ' + saved.message, userQuoteToken, buildWishPromptQuickReply(), 'elf')
      ]);
      return;
    }

    let confirmText =
      `✨ ส่งคำอวยพรขึ้นจอเวทีแล้วค่ะ!\n` +
      `💬 "${saved.wish.text}"\n` +
      `รอดูฟองคำพูดน่ารักๆ บนหัวตุ๊กตา ${saved.wish.displayName} บนจอใหญ่ได้เลย! 🎄`;
    if (!saved.wish.empId) {
      confirmText += '\n(💡 หากยังไม่ได้ลงทะเบียน เข้ากดลงทะเบียนร่วมงานเพื่อให้ตุ๊กตาของคุณปรากฏบนเวทีนะคะ)';
    }

    replyLineMessage(replyToken, [
      buildQuotedRewardTextMessage(confirmText, userQuoteToken, buildWishSentQuickReply(), 'elf')
    ]);
    return;
  }

  // 6. กรณีผู้ใช้กด Quick Reply ยกเลิกการตรวจสอบรางวัล
  if (isWaitingForEmpId && (normalizedCommand === 'ยกเลิกตรวจสอบรางวัล' || normalizedCommand === 'ยกเลิก')) {
    clearRewardWaitState();
    replyLineMessage(replyToken, [
      buildQuotedRewardTextMessage('❌ ยกเลิกการตรวจสอบรางวัลเรียบร้อยแล้วค่ะ', userQuoteToken, null)
    ]);
    return;
  }

  // รองรับกรณีพิมพ์ "ตรวจสอบรางวัล 672002" ในบรรทัดเดียวกันด้วย
  let empIdToSearch = '';
  if (/^ตรวจสอบ\s*รางวัล\s+/i.test(rawText) || (rawText.indexOf('ตรวจสอบรางวัล') === 0 && normalizedCommand !== 'ตรวจสอบรางวัล')) {
    clearWishWaitState();
    empIdToSearch = rawText.replace(/^ตรวจสอบ\s*รางวัล\s*/i, '').trim();
  } else if (isWaitingForEmpId) {
    empIdToSearch = rawText;
  }

  if (!empIdToSearch) {
    return;
  }

  // ล้างสถานะรอรหัสพนักงานเมื่อรับค่ามาตรวจสอบแล้ว
  clearRewardWaitState();

  if (rawUserId) {
    startLoadingAnimation(rawUserId, 5);
  }

  const myEmpId = findRegisteredEmpIdByUidCached(rawUserId);
  const resultQuickReply = buildRewardResultQuickReply(empIdToSearch, myEmpId);

  // ค้นหาข้อมูลจาก Sheet "gift" โดยตรวจสอบรหัสพนักงานในคอลัมน์ B2:B
  const checkResult = checkGiftRewardByEmpId(empIdToSearch);

  if (checkResult.found && checkResult.rewards.length > 0) {
    const rewardFlex = createGiftCheckFlexMessage(empIdToSearch, checkResult.rewards);
    rewardFlex.quickReply = resultQuickReply;

    const replyMessages = [];
    if (userQuoteToken) {
      replyMessages.push(
        buildQuotedRewardTextMessage(`🎉 ผลการตรวจสอบรางวัล รหัส ${empIdToSearch}: ยินดีด้วยค่ะ คุณได้รับรางวัล!`, userQuoteToken, null)
      );
    }
    replyMessages.push(rewardFlex);
    replyLineMessage(replyToken, replyMessages);
  } else {
    let empInfo = null;
    try {
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      const { employeesMap } = getRegisteredEmployeesFromRegisterSheet(ss);
      if (employeesMap && employeesMap[empIdToSearch]) {
        empInfo = employeesMap[empIdToSearch];
      } else {
        const empCheck = checkEmployeeById(empIdToSearch);
        if (empCheck && empCheck.status === 'success' && empCheck.data) {
          empInfo = empCheck.data;
        }
      }
    } catch (infoErr) {
      console.warn('Error fetching empInfo for no reward flex:', infoErr);
    }

    const noRewardFlex = createNoRewardFlexMessage(empIdToSearch, empInfo);
    noRewardFlex.quickReply = resultQuickReply;

    const replyMessages = [];
    if (userQuoteToken) {
      replyMessages.push(
        buildQuotedRewardTextMessage(`📋 ผลการตรวจสอบรางวัล รหัส ${empIdToSearch}: ท่านไม่ได้รางวัลค่ะ`, userQuoteToken, null)
      );
    }
    replyMessages.push(noRewardFlex);
    replyLineMessage(replyToken, replyMessages);
  }
}

/**
 * สร้างข้อความ Text พร้อมแนบ quoteToken (อ้างอิงข้อความผู้ใช้) และ quickReply สำหรับระบบตรวจสอบรางวัล
 */
function buildQuotedRewardTextMessage(text, quoteToken, quickReply, senderKey = 'santa') {
  const msg = {
    type: 'text',
    text: String(text || '')
  };
  if (quoteToken) {
    msg.quoteToken = quoteToken;
  }
  if (quickReply && Array.isArray(quickReply.items) && quickReply.items.length > 0) {
    msg.quickReply = quickReply;
  }
  return senderKey ? withBotSender(msg, senderKey) : msg;
}

/**
 * ค้นหารหัสพนักงานของผู้ใช้ที่ลงทะเบียนไว้ใน Sheet "Register" จาก LINE UID (ใช้ Cache ช่วยลดการอ่านซ้ำ)
 */
function findRegisteredEmpIdByUidCached(uid) {
  if (!uid || uid === 'anon') return '';
  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = 'REG_EMP_BY_UID_' + uid;
    const cached = cache.get(cacheKey);
    if (cached === '__NONE__') return '';
    if (cached) return cached;

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const { employeesMap } = getRegisteredEmployeesFromRegisterSheet(ss);
    const entries = Object.values(employeesMap || {});
    for (let i = 0; i < entries.length; i++) {
      if (entries[i] && entries[i].uid === uid && entries[i].empId) {
        cache.put(cacheKey, entries[i].empId, 600);
        return entries[i].empId;
      }
    }

    cache.put(cacheKey, '__NONE__', 30);
  } catch (err) {
    console.warn('findRegisteredEmpIdByUidCached warning:', err);
  }
  return '';
}

/**
 * สร้าง Quick Reply สำหรับขั้นตอนขอรับรหัสพนักงานเพื่อตรวจสอบรางวัล
 */
function buildRewardPromptQuickReply(myEmpId) {
  const items = [];
  if (myEmpId) {
    items.push({
      type: 'action',
      action: {
        type: 'message',
        label: ('เช็ครหัสฉัน: ' + myEmpId).slice(0, 20),
        text: String(myEmpId)
      }
    });
  }
  items.push({
    type: 'action',
    action: {
      type: 'message',
      label: '❌ ยกเลิก',
      text: 'ยกเลิกตรวจสอบรางวัล'
    }
  });
  return { items: items };
}

/**
 * สร้าง Quick Reply สำหรับขั้นตอนหลังแสดงผลการตรวจสอบรางวัล
 */
function buildRewardResultQuickReply(checkedEmpId, myEmpId) {
  const items = [
    {
      type: 'action',
      action: {
        type: 'message',
        label: '🔍 ตรวจรหัสอื่น',
        text: 'ตรวจสอบรางวัล'
      }
    }
  ];

  if (myEmpId && String(myEmpId) !== String(checkedEmpId)) {
    items.push({
      type: 'action',
      action: {
        type: 'message',
        label: ('เช็ครหัสฉัน: ' + myEmpId).slice(0, 20),
        text: 'ตรวจสอบรางวัล ' + myEmpId
      }
    });
  }

  items.push({
    type: 'action',
    action: {
      type: 'message',
      label: '🔄 เช็ครหัสเดิมอีก',
      text: 'ตรวจสอบรางวัล ' + checkedEmpId
    }
  });

  if (checkedEmpId) {
    items.push({
      type: 'action',
      action: {
        type: 'clipboard',
        label: ('คัดลอกรหัส ' + checkedEmpId).slice(0, 20),
        clipboardText: String(checkedEmpId)
      }
    });
  }

  return { items: items };
}

const LIVE_WISHES_PROP_KEY = 'LIVE_PARTY_WISHES';
const LIVE_WISHES_CACHE_KEY = 'LIVE_PARTY_WISHES_CACHE';
const LIVE_WISH_TTL_MS = 30 * 60 * 1000;
const LIVE_WISH_MAX_ITEMS = 40;

/**
 * บันทึกคำอวยพรขึ้นจอเวที (Live Party Wishes) พร้อมผูกกับรหัสพนักงานและชื่อผู้ร่วมงาน
 */
function saveLivePartyWish(userId, rawWishText) {
  const cleanWish = String(rawWishText || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 45);

  if (!cleanWish) {
    return { success: false, message: 'กรุณาพิมพ์ข้อความอวยพรก่อนส่งนะคะ' };
  }

  const cache = CacheService.getScriptCache();

  // ป้องกันการส่งคำอวยพรซ้ำถี่เกินไป (Cooldown 15 วินาทีต่อคน)
  if (userId && userId !== 'anon') {
    try {
      if (cache.get('WISH_COOLDOWN_' + userId)) {
        return {
          success: false,
          cooldown: true,
          message: 'ส่งคำอวยพรถี่เกินไปนิดนึงค่ะ รอสัก 15 วินาทีแล้วส่งใหม่อีกครั้งนะคะ ✨'
        };
      }
    } catch (cdErr) {}
  }

  let empId = '';
  let displayName = '';

  if (userId && userId !== 'anon') {
    const profileCacheKey = 'WISH_USER_META_' + userId;
    try {
      const cachedMeta = cache.get(profileCacheKey);
      if (cachedMeta) {
        const parsedMeta = JSON.parse(cachedMeta);
        empId = parsedMeta.empId || '';
        displayName = parsedMeta.displayName || '';
      }
    } catch (e) {}

    if (!displayName) {
      try {
        const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
        const { employeesMap } = getRegisteredEmployeesFromRegisterSheet(ss);
        const entries = Object.values(employeesMap || {});
        for (let i = 0; i < entries.length; i++) {
          if (entries[i] && entries[i].uid === userId) {
            empId = entries[i].empId || '';
            displayName = entries[i].displayName || entries[i].empName || '';
            break;
          }
        }
      } catch (lookupErr) {
        console.warn('saveLivePartyWish Sheet lookup warning:', lookupErr);
      }

      if (!displayName) {
        const profile = getUserProfile(userId);
        displayName = (profile && profile.displayName) ? String(profile.displayName).trim() : '';
      }

      if (!displayName) displayName = 'ผู้ร่วมงาน';

      try {
        cache.put(profileCacheKey, JSON.stringify({ empId: empId, displayName: displayName }), 300);
      } catch (cacheErr) {}
    }
  } else {
    displayName = 'ผู้ร่วมงาน';
  }

  const now = Date.now();
  const newWish = {
    id: now + '_' + Math.floor(Math.random() * 10000),
    empId: empId,
    uid: userId || '',
    displayName: displayName,
    text: cleanWish,
    createdAt: now
  };

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    const props = PropertiesService.getScriptProperties();
    let list = [];
    try {
      const rawJson = props.getProperty(LIVE_WISHES_PROP_KEY);
      if (rawJson) {
        const parsed = JSON.parse(rawJson);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch (parseErr) {}

    list = list.filter(w => {
      if (!w || !w.text) return false;
      if (now - Number(w.createdAt || 0) > LIVE_WISH_TTL_MS) return false;
      if (userId && w.uid === userId) return false;
      if (empId && w.empId === empId) return false;
      return true;
    });

    list.unshift(newWish);
    if (list.length > LIVE_WISH_MAX_ITEMS) {
      list = list.slice(0, LIVE_WISH_MAX_ITEMS);
    }

    props.setProperty(LIVE_WISHES_PROP_KEY, JSON.stringify(list));
    cache.remove(LIVE_WISHES_CACHE_KEY);
    if (userId && userId !== 'anon') {
      try {
        cache.put('WISH_COOLDOWN_' + userId, '1', 15);
      } catch (cdPutErr) {}
    }
  } finally {
    lock.releaseLock();
  }

  return {
    success: true,
    wish: {
      id: newWish.id,
      empId: newWish.empId,
      displayName: newWish.displayName,
      text: newWish.text,
      createdAt: newWish.createdAt
    }
  };
}

/**
 * ดึงรายการคำอวยพรล่าสุดสำหรับแสดงบนหัวตุ๊กตาในสไลด์โชว์ (ตัด uid ออกเพื่อความปลอดภัย)
 */
function getLivePartyWishes() {
  const cache = CacheService.getScriptCache();
  try {
    const cached = cache.get(LIVE_WISHES_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}

  const now = Date.now();
  let publicWishes = [];
  try {
    const props = PropertiesService.getScriptProperties();
    const rawJson = props.getProperty(LIVE_WISHES_PROP_KEY);
    if (rawJson) {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        publicWishes = parsed
          .filter(w => w && w.text && (now - Number(w.createdAt || 0) <= LIVE_WISH_TTL_MS))
          .map(w => ({
            id: String(w.id || ''),
            empId: String(w.empId || ''),
            displayName: String(w.displayName || ''),
            text: String(w.text || ''),
            createdAt: Number(w.createdAt || 0)
          }));
      }
    }
  } catch (err) {
    console.warn('getLivePartyWishes warning:', err);
  }

  try {
    cache.put(LIVE_WISHES_CACHE_KEY, JSON.stringify(publicWishes), 5);
  } catch (cacheErr) {}

  return publicWishes;
}

function buildWishPromptQuickReply() {
  return {
    items: [
      {
        type: 'action',
        action: {
          type: 'message',
          label: 'Merry Christmas 🎄',
          text: 'อวยพร Merry Christmas 🎄✨'
        }
      },
      {
        type: 'action',
        action: {
          type: 'message',
          label: 'ขอได้รางวัลใหญ่ 🎁',
          text: 'อวยพร ขอให้ได้รางวัลใหญ่! 🎁'
        }
      },
      {
        type: 'action',
        action: {
          type: 'message',
          label: 'HNY 2026 ปังๆ 🎉',
          text: 'อวยพร HNY 2026 รวยๆ ปังๆ 🎉'
        }
      },
      {
        type: 'action',
        action: {
          type: 'message',
          label: '❌ ยกเลิก',
          text: 'ยกเลิกอวยพร'
        }
      }
    ]
  };
}

function buildWishSentQuickReply() {
  return {
    items: [
      {
        type: 'action',
        action: {
          type: 'message',
          label: '💬 ส่งคำอวยพรอีก',
          text: 'อวยพรขึ้นจอ'
        }
      },
      {
        type: 'action',
        action: {
          type: 'message',
          label: '🥠 เสี่ยงเซียมซี',
          text: 'เสี่ยงเซียมซี'
        }
      },
      {
        type: 'action',
        action: {
          type: 'message',
          label: '📸 ภาพกิจกรรมในงาน',
          text: 'ภาพกิจกรรมในงาน'
        }
      },
      {
        type: 'action',
        action: {
          type: 'message',
          label: '🎁 ตรวจสอบรางวัล',
          text: 'ตรวจสอบรางวัล'
        }
      }
    ]
  };
}

/**
 * มินิเกม "เสี่ยงเซียมซีปีใหม่ 2026" สำหรับส่งผลคำทำนายสนุกๆ ในแชท LINE
 */
function buildNewYearFortuneMessage(userQuoteToken) {
  const fortunes = [
    { no: 1, level: '🌟 มหาเฮง!', text: 'คืนนี้รัศมีผู้โชคดีจับมาก! มีเกณฑ์ได้เฮเสียงดังตอนจับรางวัลใหญ่ แถมปีใหม่ 2026 งานรุ่ง เงินพุ่งไม่หยุด', lucky: 'หมวกซานต้าสีแดง 🎅' },
    { no: 2, level: '✨ ดีมาก!', text: 'คนรอบข้างรักใคร่เอ็นดู เพื่อนร่วมงานซัพพอร์ตสุดๆ ปีหน้าโปรเจกต์ไหนก็ผ่านฉลุยไร้ดราม่า', lucky: 'เครื่องดื่มเย็นๆ สักแก้ว 🥂' },
    { no: 3, level: '💎 โชคลาภเด่น!', text: 'ดวงการเงินและโบนัสเปิดทางสว่างไสว สิ่งที่ตั้งใจไว้กำลังจะออกดอกออกผลให้ชื่นใจในไม่ช้า', lucky: 'สติกเกอร์ดาวทอง ⭐' },
    { no: 4, level: '🎁 มีลุ้นรางวัล!', text: 'ค่ำคืนนี้หัวใจจะพองโต! มีเกณฑ์ได้รับของขวัญสุดเซอร์ไพรส์ หรือมีคนเลี้ยงของอร่อยแบบไม่ทันตั้งตัว', lucky: 'ริบบิ้นสีทอง 🎀' },
    { no: 5, level: '🌈 สดใสเกินต้าน!', text: 'พลังงานบวกมาเต็มร้อย! ยิ้มบ่อยๆ เข้าไว้ คืนนี้จะถ่ายรูปมุมไหนก็เป๊ะปังติดหน้าจอใหญ่แน่นอน', lucky: 'กล้องถ่ายรูป 📸' },
    { no: 6, level: '🍀 เฮงคูณสอง!', text: 'ใครที่เคยเหนื่อยมาตลอดปี ถึงเวลาพักใจให้เต็มที่แล้วรับโชคก้อนโตต้อนรับปี 2026 ได้เลย!', lucky: 'ใบโคลเวอร์สีเขียว 🍀' },
    { no: 7, level: '👑 ตัวตึงประจำงาน!', text: 'เสน่ห์แรงสุดในปาร์ตี้! เดินไปมุมไหนก็มีแต่คนชวนคุย ชวนถ่ายรูป มิตรภาพดีๆ จะพาโอกาสใหม่ๆ มาให้', lucky: 'แว่นตาแฟนซี 😎' },
    { no: 8, level: '🚀 พุ่งทะยาน!', text: 'ปี 2026 จะเป็นปีแห่งการเติบโตแบบก้าวกระโดด ไอเดียที่คิดไว้จะปังจนใครๆ ก็ต้องปรบมือให้', lucky: 'ขนมหวานชิ้นโปรด 🧁' },
    { no: 9, level: '💝 อิ่มสุขใจฟู!', text: 'ความสุขอยู่ใกล้แค่เอื้อม สุขภาพแข็งแรง หลับสบาย ไร้เรื่องกวนใจ มีแต่เสียงหัวเราะตลอดเทศกาล', lucky: 'คุกกี้ขิง 🍪' },
    { no: 10, level: '🎯 แม่นดั่งจับวาง!', text: 'คิดอะไรไว้ให้รีบลงมือทำเลย เพราะจังหวะดีๆ เข้าข้างคุณอยู่ โชคเล็กโชคใหญ่กำลังต่อคิวมาหา!', lucky: 'กล่องของขวัญสีเขียว 🎁' },
    { no: 11, level: '🌟 ดาวเด่นนำโชค!', text: 'ออร่าความสำเร็จสว่างวาบ! คืนนี้ลองส่งคำอวยพรขึ้นจอเวทีดูนะ แล้วความสุขจะย้อนกลับมาหาคุณสิบเท่า', lucky: 'ลูกบอลประดับต้นสน 🎄' },
    { no: 12, level: '🎊 รวยความสุข!', text: 'เงินทองไม่ขาดมือ งานยากแค่ไหนก็จัดการได้อยู่หมัด แถมมีดวงเดินทางท่องเที่ยวรับปีใหม่อย่างราบรื่น', lucky: 'กระดิ่งทอง 🔔' },
    { no: 13, level: '🔥 ฟอร์มกำลังฮอต!', text: 'พกความมั่นใจมาเต็มกระเป๋า คืนนี้เอ็นจอยให้สุดเหวี่ยง แล้วพรุ่งนี้ความโชคดีจะเดินตามคุณไปทุกที่!', lucky: 'ถุงเท้าคริสต์มาส 🧦' },
    { no: 14, level: '💖 กัลยาณมิตร!', text: 'จะเจอข่าวดีจากคนที่ทำงานร่วมกัน ความสามัคคีในทีมจะสร้างผลงานชิ้นโบว์แดงประจำปี 2026', lucky: 'ช็อกโกแลตร้อน ☕' },
    { no: 15, level: '✨ ปาฏิหาริย์ปีใหม่!', text: 'เรื่องที่ลุ้นมานานกำลังจะสมหวังแบบน่ารักน่าเอ็นดู อย่าลืมส่งยิ้มให้กล้องในงานด้วยล่ะ!', lucky: 'ไฟประดับระยิบระยับ ✨' },
    { no: 16, level: '🎉 ซุปเปอร์สตาร์!', text: 'โชคชะตาจัดคิวความสนุกให้คุณแบบ VIP ทั้งคืนนี้และตลอดปีหน้า เตรียมรับทรัพย์รับความสุขได้เลย!', lucky: 'ลูกกวาดแคนดี้เคน 🍬' },
    { no: 17, level: '🌷 สบายใจหายห่วง!', text: 'อุปสรรคที่เคยติดขัดจะคลี่คลายเหมือนหิมะละลาย เหลือไว้แต่ความสดชื่นและความสำเร็จที่รออยู่', lucky: 'ตุ๊กตาหิมะยิ้มหวาน ⛄' },
    { no: 18, level: '🏆 แชมป์แห่งรอยยิ้ม!', text: 'คำทำนายบอกว่าคุณคือหนึ่งในความน่ารักของงานนี้! ขอให้มีความสุขล้นปรี่และเฮงตลอดปี 2026 ค่ะ', lucky: 'มงกุฎดาว 👑' }
  ];

  const picked = fortunes[Math.floor(Math.random() * fortunes.length)];

  const fortuneQuickReply = {
    items: [
      {
        type: 'action',
        action: {
          type: 'message',
          label: '🥠 เสี่ยงอีกครั้ง',
          text: 'เสี่ยงเซียมซี'
        }
      },
      {
        type: 'action',
        action: {
          type: 'message',
          label: '💬 อวยพรขึ้นจอ',
          text: 'อวยพรขึ้นจอ'
        }
      },
      {
        type: 'action',
        action: {
          type: 'message',
          label: '🎁 ตรวจสอบรางวัล',
          text: 'ตรวจสอบรางวัล'
        }
      },
      {
        type: 'action',
        action: {
          type: 'message',
          label: '📸 ภาพกิจกรรมในงาน',
          text: 'ภาพกิจกรรมในงาน'
        }
      }
    ]
  };

  const fortuneFlex = {
    type: 'flex',
    altText: `🥠 เซียมซีปีใหม่ CM Party 2026 • ใบที่ ${picked.no} (${picked.level}): ${picked.text}`,
    quickReply: fortuneQuickReply,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#9F1239',
        background: {
          type: 'linearGradient',
          angle: '135deg',
          startColor: '#9F1239',
          centerColor: '#7F1D1D',
          centerPosition: '55%',
          endColor: '#580B24'
        },
        paddingAll: '18px',
        spacing: 'xs',
        alignItems: 'center',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            backgroundColor: '#F5B942',
            cornerRadius: '20px',
            paddingStart: '12px',
            paddingEnd: '12px',
            paddingTop: '4px',
            paddingBottom: '4px',
            contents: [
              {
                type: 'text',
                text: `🥠 เซียมซีปีใหม่ 2026 • ใบที่ ${picked.no}`,
                color: '#450A0A',
                size: 'xxs',
                weight: 'bold',
                align: 'center'
              }
            ]
          },
          {
            type: 'text',
            text: picked.level,
            color: '#FEF08A',
            size: 'xl',
            weight: 'bold',
            align: 'center',
            margin: 'sm'
          },
          {
            type: 'text',
            text: 'CM Party 2026 • Golden Fortune Slip',
            color: '#FECDD3',
            size: 'xxs',
            align: 'center'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFBF7',
        paddingAll: '18px',
        spacing: 'md',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FFF1F2',
            borderColor: '#F5B942',
            borderWidth: '2px',
            cornerRadius: '16px',
            paddingAll: '16px',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                text: '📜 คำทำนายดวงปาร์ตี้ & ปีใหม่ของคุณ',
                color: '#9F1239',
                size: 'xs',
                weight: 'bold',
                align: 'center'
              },
              {
                type: 'separator',
                color: '#FECDD3'
              },
              {
                type: 'text',
                text: picked.text,
                color: '#4C0519',
                size: 'sm',
                weight: 'bold',
                align: 'center',
                wrap: true,
                margin: 'sm'
              }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#ECFDF5',
            borderColor: '#6EE7B7',
            borderWidth: '1px',
            cornerRadius: '14px',
            paddingAll: '12px',
            spacing: 'xs',
            contents: [
              {
                type: 'text',
                text: '🍀 ไอเทมเสริมดวงนำโชคคืนนี้',
                color: '#047857',
                size: 'xxs',
                weight: 'bold',
                align: 'center'
              },
              {
                type: 'text',
                text: picked.lucky,
                color: '#065F46',
                size: 'sm',
                weight: 'bold',
                align: 'center',
                wrap: true
              }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#14532D',
        paddingAll: '14px',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#D97706',
            height: 'sm',
            action: {
              type: 'message',
              label: '🥠 เสี่ยงเซียมซีอีก',
              text: 'เสี่ยงเซียมซี'
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#BE123C',
            height: 'sm',
            action: {
              type: 'message',
              label: '💬 ส่งคำอวยพรขึ้นจอ',
              text: 'อวยพรขึ้นจอ'
            }
          }
        ]
      }
    }
  };

  return withBotSender(fortuneFlex, 'elf');
}

function buildPartyMenuFlexMessage(quickReply) {
  const buildGuideItem = (iconText, titleText, descText, bgCol, borderCol, titleCol) => ({
    type: 'box',
    layout: 'horizontal',
    backgroundColor: bgCol,
    borderColor: borderCol,
    borderWidth: '1px',
    cornerRadius: '12px',
    paddingAll: '10px',
    spacing: 'sm',
    alignItems: 'center',
    contents: [
      {
        type: 'text',
        text: iconText,
        size: 'lg',
        flex: 0
      },
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        spacing: 'xs',
        contents: [
          {
            type: 'text',
            text: titleText,
            color: titleCol,
            size: 'xs',
            weight: 'bold',
            wrap: true
          },
          {
            type: 'text',
            text: descText,
            color: '#4B5563',
            size: 'xxs',
            wrap: true
          }
        ]
      }
    ]
  });

  const menuFlex = {
    type: 'flex',
    altText: '🎄 คู่มือร่วมสนุก CM Party 2026: ส่งรูปขึ้นจอ อวยพร เสี่ยงเซียมซี และตรวจรางวัล',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#9F1239',
        background: {
          type: 'linearGradient',
          angle: '135deg',
          startColor: '#9F1239',
          centerColor: '#7F1D1D',
          centerPosition: '55%',
          endColor: '#580B24'
        },
        paddingAll: '18px',
        spacing: 'xs',
        alignItems: 'center',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            backgroundColor: '#F5B942',
            cornerRadius: '20px',
            paddingStart: '12px',
            paddingEnd: '12px',
            paddingTop: '4px',
            paddingBottom: '4px',
            contents: [
              {
                type: 'text',
                text: '🎄 CM PARTY 2026 • PARTY PASSPORT',
                color: '#450A0A',
                size: 'xxs',
                weight: 'bold',
                align: 'center'
              }
            ]
          },
          {
            type: 'text',
            text: 'เมนูสนุก & ส่งรูปขึ้นจอใหญ่ ✨',
            color: '#FFFFFF',
            size: 'lg',
            weight: 'bold',
            align: 'center',
            margin: 'sm'
          },
          {
            type: 'text',
            text: 'เลือกกิจกรรมด้านล่าง หรือส่งรูปถ่ายเข้าแชทนี้ได้เลย!',
            color: '#FEF08A',
            size: 'xxs',
            align: 'center',
            wrap: true
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFBF7',
        paddingAll: '16px',
        spacing: 'sm',
        contents: [
          buildGuideItem(
            '📸',
            'ส่งรูปถ่ายขึ้นจอแกลเลอรีทันที',
            'กดเลือกรูปส่งเข้าห้องแชทนี้ รูปจะแสดงบนสไลด์โชว์หน้าเวทีอัตโนมัติ',
            '#ECFDF5',
            '#A7F3D0',
            '#065F46'
          ),
          buildGuideItem(
            '💬',
            'ส่งคำอวยพรเด้งบนหัวตุ๊กตา',
            'กดปุ่มอวยพรขึ้นจอ ข้อความจะลอยขึ้นบนตัวละครของคุณหน้าเวที',
            '#FFF1F2',
            '#FECDD3',
            '#9F1239'
          ),
          buildGuideItem(
            '🎁',
            'ตรวจสอบผลรางวัล Lucky Draw',
            'เช็กสิทธิ์และผลรางวัลของคุณได้ทันทีด้วยรหัสพนักงาน',
            '#FEF3C7',
            '#FDE68A',
            '#92400E'
          ),
          buildGuideItem(
            '🥠',
            'เสี่ยงเซียมซีปีใหม่ 2026',
            'รับใบเซียมซีทองคำทำนายดวงปังๆ พร้อมไอเทมนำโชคคืนนี้',
            '#FFF7ED',
            '#FED7AA',
            '#9A3412'
          )
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#14532D',
        paddingAll: '14px',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#D97706',
            height: 'sm',
            action: {
              type: 'uri',
              label: '📝 ลงทะเบียน / บัตร VIP',
              uri: LIFF_REGISTER_URL
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#BE123C',
            height: 'sm',
            action: {
              type: 'message',
              label: '💬 ส่งคำอวยพรขึ้นจอ',
              text: 'อวยพรขึ้นจอ'
            }
          }
        ]
      }
    }
  };

  if (quickReply && Array.isArray(quickReply.items) && quickReply.items.length > 0) {
    menuFlex.quickReply = quickReply;
  }

  return withBotSender(menuFlex, 'elf');
}

/**
 * ค้นหารหัสพนักงานใน Sheet "gift" คอลัมน์ B2:B
 * โครงสร้าง Sheet gift: A(0)=ชื่อรางวัล, B(1)=รหัสพนักงาน, C(2)=ชื่อ, D(3)=แผนก, E(4)=สาขา, F(5)=uid
 */
function checkGiftRewardByEmpId(empIdInput) {
  const searchId = String(empIdInput || '').trim().replace(/\.0$/, '');
  if (!searchId) {
    return { found: false, rewards: [] };
  }

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const giftSheet = getSheetSafely(ss, GIFT_SHEET_NAME) || getRewardSheet(ss);
  if (!giftSheet || giftSheet.getLastRow() < 2) {
    return { found: false, rewards: [] };
  }

  const lastRow = giftSheet.getLastRow();
  const lastCol = Math.max(6, giftSheet.getLastColumn());
  // อ่านข้อมูลตั้งแต่แถวที่ 2 ถึงแถวสุดท้าย (คอลัมน์ B2:B คือ index 1)
  const data = giftSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const matchedRewards = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowEmpId = String(row[1] || '').trim().replace(/\.0$/, '');

    if (rowEmpId && rowEmpId.toLowerCase() === searchId.toLowerCase()) {
      matchedRewards.push({
        rewardName: String(row[0] || '').trim() || '-',
        empId: rowEmpId,
        empName: String(row[2] || '').trim() || '-',
        department: String(row[3] || '').trim() || '-',
        branch: String(row[4] || '').trim() || '-'
      });
    }
  }

  // หากใน Sheet gift มีรหัสพนักงานใน B2:B แต่ยังไม่ได้กรอกชื่อ/แผนก/สาขา ให้ดึงเสริมจาก Sheet Register
  if (matchedRewards.length > 0 && (matchedRewards[0].empName === '-' || !matchedRewards[0].empName)) {
    const { employeesMap } = getRegisteredEmployeesFromRegisterSheet(ss);
    const regEmp = employeesMap[searchId];
    if (regEmp) {
      for (let j = 0; j < matchedRewards.length; j++) {
        if (matchedRewards[j].empName === '-') matchedRewards[j].empName = regEmp.empName || '-';
        if (matchedRewards[j].department === '-') matchedRewards[j].department = regEmp.department || '-';
        if (matchedRewards[j].branch === '-') matchedRewards[j].branch = regEmp.branch || '-';
      }
    }
  }

  return {
    found: matchedRewards.length > 0,
    rewards: matchedRewards
  };
}

/**
 * สร้าง Flex Message แสดงผลการตรวจสอบรางวัลจาก Sheet "gift"
 */
function createGiftCheckFlexMessage(empId, rewardsList) {
  const first = rewardsList[0];
  const allPrizeNames = rewardsList.map(r => r.rewardName).join(', ');
  const nowStr = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

  const prizeBoxes = rewardsList.map((item, idx) => ({
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#0000004D',
    borderColor: '#FBBF2499',
    borderWidth: '2px',
    cornerRadius: '14px',
    paddingAll: '14px',
    alignItems: 'center',
    spacing: 'xs',
    margin: idx > 0 ? 'sm' : 'none',
    contents: [
      {
        type: 'text',
        text: rewardsList.length > 1 ? `รางวัลที่ได้รับ (#${idx + 1})` : 'รางวัลที่ได้รับ',
        color: '#FDE68A',
        size: 'xs',
        weight: 'bold'
      },
      {
        type: 'text',
        text: item.rewardName || '-',
        color: '#FFFFFF',
        size: 'lg',
        weight: 'bold',
        align: 'center',
        wrap: true
      }
    ]
  }));

  return buildChristmasGlassFlexMessage({
    senderKey: 'santa',
    altText: `🎉 ผลการตรวจสอบรางวัล รหัส ${first.empId}: ได้รับ ${allPrizeNames}`,
    bgImageUrl: 'https://cmparty.vercel.app/assets/flex-giftbox.jpg',
    badgeText: 'REWARD CHECK',
    title: '🎉 ยินดีด้วย! คุณได้รับรางวัล',
    subtitle: 'ข้อมูลจากระบบตรวจสอบรางวัล (Sheet gift)',
    glassCardContents: [
      ...prizeBoxes,
      { type: 'separator', color: '#FFFFFF33' },
      {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          buildFlexInfoRow('รหัสพนักงาน', first.empId || empId, '#FFFFFF', 'sm', 'bold'),
          buildFlexInfoRow('ชื่อ - สกุล', first.empName, '#FFFFFF', 'sm', 'bold'),
          buildFlexInfoRow('แผนก', first.department, '#F3F4F6', 'xs'),
          buildFlexInfoRow('สาขา', first.branch, '#86EFAC', 'xs', 'bold')
        ]
      }
    ],
    footerSpacing: 'sm',
    footerContents: [
      {
        type: 'text',
        text: 'กรุณาแสดงหน้าจอนี้เพื่อติดต่อรับรางวัลกับเจ้าหน้าที่',
        color: '#FEF08A',
        size: 'xs',
        weight: 'bold',
        align: 'center',
        wrap: true
      },
      {
        type: 'button',
        style: 'primary',
        color: '#DC2626',
        height: 'sm',
        action: { type: 'message', label: 'ตรวจสอบรางวัล', text: 'ตรวจสอบรางวัล' }
      },
      {
        type: 'text',
        text: 'ข้อมูล ณ เวลา: ' + nowStr,
        color: '#86EFAC',
        size: 'xxs',
        align: 'center',
        margin: 'xs'
      }
    ]
  });
}

/**
 * สร้าง Flex Message แจ้งผลเมื่อตรวจสอบแล้วไม่ได้รับรางวัล ("ท่านไม่ได้รางวัลค่ะ")
 */
function createNoRewardFlexMessage(empId, empInfo) {
  const nowStr = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const empName = (empInfo && empInfo.empName && empInfo.empName !== '-') ? empInfo.empName : '';
  const department = (empInfo && empInfo.department && empInfo.department !== '-') ? empInfo.department : '';
  const branch = (empInfo && empInfo.branch && empInfo.branch !== '-') ? empInfo.branch : '';

  const employeeDetailRows = [
    buildFlexInfoRow('รหัสพนักงาน', empId, '#FFFFFF', 'sm', 'bold')
  ];

  if (empName) {
    employeeDetailRows.push(buildFlexInfoRow('ชื่อ - สกุล', empName, '#FFFFFF', 'sm', 'bold'));
  }
  if (department) {
    employeeDetailRows.push(buildFlexInfoRow('แผนก', department, '#F3F4F6', 'xs'));
  }
  if (branch) {
    employeeDetailRows.push(buildFlexInfoRow('สาขา', branch, '#86EFAC', 'xs', 'bold'));
  }

  return buildChristmasGlassFlexMessage({
    senderKey: 'santa',
    altText: `ผลการตรวจสอบรางวัล รหัส ${empId}: ท่านไม่ได้รางวัลค่ะ`,
    bgImageUrl: 'https://cmparty.vercel.app/assets/flex-giftbox.jpg',
    badgeText: 'REWARD CHECK',
    badgeBgColor: '#FDE68A',
    title: '🎄 ท่านไม่ได้รางวัลค่ะ',
    subtitle: 'ระบบตรวจสอบรางวัล CM Party',
    glassCardContents: [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0000004D',
        borderColor: '#FCA5A588',
        borderWidth: '2px',
        cornerRadius: '14px',
        paddingAll: '14px',
        alignItems: 'center',
        spacing: 'xs',
        contents: [
          { type: 'text', text: '🎁 สถานะการรับรางวัล', color: '#FDE68A', size: 'xs', weight: 'bold' },
          { type: 'text', text: 'ท่านไม่ได้รางวัลค่ะ', color: '#FECACA', size: 'lg', weight: 'bold', align: 'center', margin: 'xs' },
          {
            type: 'text',
            text: 'ขอขอบคุณที่ร่วมสนุกกับงานเลี้ยง CM Party ลุ้นใหม่ในรอบถัดไปนะคะ',
            color: '#E5E7EB',
            size: 'xs',
            align: 'center',
            wrap: true,
            margin: 'sm'
          }
        ]
      },
      { type: 'separator', color: '#FFFFFF33' },
      {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: employeeDetailRows
      }
    ],
    footerSpacing: 'sm',
    footerContents: [
      {
        type: 'button',
        style: 'primary',
        color: '#DC2626',
        height: 'sm',
        action: { type: 'message', label: 'ตรวจสอบรางวัล', text: 'ตรวจสอบรางวัล' }
      },
      {
        type: 'text',
        text: 'กดปุ่มด้านบนเพื่อตรวจสอบรางวัลอีกครั้ง',
        color: '#FEF08A',
        size: 'xxs',
        align: 'center',
        margin: 'xs'
      },
      {
        type: 'text',
        text: 'ข้อมูล ณ เวลา: ' + nowStr,
        color: '#86EFAC',
        size: 'xxs',
        align: 'center'
      }
    ]
  });
}

// ==========================================
// 11. จัดการ Event เพิ่มเพื่อน (Follow Event) และอัปโหลดรูปภาพ (Image Message)
// ==========================================
function handleFollowEvent(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;

  if (userId) {
    startLoadingAnimation(userId, 5);
  }

  const profile = getUserProfile(userId);
  const welcomeFlex = createWelcomeFlexMessage(profile);

  replyLineMessage(replyToken, [welcomeFlex]);
}

function handleImageMessage(event) {
  const messageId = event.message.id;
  const replyToken = event.replyToken;
  const userId = event.source.userId || '';
  const quoteToken = (event.message && event.message.quoteToken) ? String(event.message.quoteToken).trim() : '';

  try {
    if (userId) {
      startLoadingAnimation(userId, 20);
    }

    const imageBlob = getLineMessageContent(messageId);
    const timestamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss');
    const shortId = userId ? userId.substring(0, 6) : 'user';
    const fileName = `LINE_${shortId}_${timestamp}_${messageId}.jpg`;
    imageBlob.setName(fileName);

    const folder = getTargetDriveFolder();
    const file = folder.createFile(imageBlob);

    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // ล้างแคชรายการรูปภาพทันที เพื่อให้สไลด์โชว์และแกลเลอรีดึงภาพใหม่ได้ทันที
    try {
      CacheService.getScriptCache().remove('GALLERY_IMAGES_CACHE');
    } catch (cacheClearErr) {}

    const photoQuickReply = {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: '📸 ภาพกิจกรรมในงาน',
            text: 'ภาพกิจกรรมในงาน'
          }
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '💬 อวยพรขึ้นจอ',
            text: 'อวยพรขึ้นจอ'
          }
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '🥠 เสี่ยงเซียมซี',
            text: 'เสี่ยงเซียมซี'
          }
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '🎁 ตรวจสอบรางวัล',
            text: 'ตรวจสอบรางวัล'
          }
        }
      ]
    };

    const replyText = '📸 อัปโหลดภาพความประทับใจขึ้นจอแกลเลอรีเรียบร้อยแล้วค่ะ!\nรอชมภาพสวยๆ บนจอใหญ่ในงานได้เลย ✨';
    replyLineMessage(replyToken, [
      buildQuotedRewardTextMessage(replyText, quoteToken, photoQuickReply, 'photo')
    ]);
  } catch (err) {
    console.error('Error handling image:', err);
    replyLineMessage(replyToken, [
      buildQuotedRewardTextMessage('❌ เกิดข้อผิดพลาดในการอัปโหลดรูปภาพ: ' + err.message, quoteToken, null, 'photo')
    ]);
  }
}

// ==========================================
// 12. ฟังก์ชันเชื่อมต่อ LINE Messaging API & Google Drive
// ==========================================
function startLoadingAnimation(chatId, loadingSeconds = 20) {
  const url = 'https://api.line.me/v2/bot/chat/loading/start';
  const payload = {
    chatId: chatId,
    loadingSeconds: loadingSeconds
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + getLineBotAccessToken()
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    return UrlFetchApp.fetch(url, options);
  } catch (e) {
    console.error('Error starting loading animation:', e);
  }
}

function getUserProfile(userId) {
  const url = `https://api.line.me/v2/bot/profile/${userId}`;
  const options = {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + getLineBotAccessToken()
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() === 200) {
      return JSON.parse(response.getContentText());
    }
  } catch (e) {
    console.error('Error fetching profile:', e);
  }

  return {
    userId: userId || '-',
    displayName: 'เพื่อนใหม่',
    pictureUrl: 'https://lh5.googleusercontent.com/d/1_default_avatar',
    statusMessage: 'ยินดีต้อนรับสู่บริการของเรา!'
  };
}

/**
 * ตรวจสอบว่าผู้ใช้กดเพิ่มเพื่อนกับ LINE Official Account แล้วหรือไม่
 * (ถ้ายังไม่ได้กดเพิ่มเพื่อน LINE API get profile จะส่ง HTTP 404 กลับมา)
 */
function isUserFriendWithBot(userId, bypassCache) {
  if (!userId || userId === 'anon') return false;

  const cache = CacheService.getScriptCache();
  const cacheKey = 'IS_FRIEND_' + userId;

  if (!bypassCache) {
    const cachedVal = cache.get(cacheKey);
    if (cachedVal === '1') return true;
  }

  const url = `https://api.line.me/v2/bot/profile/${userId}`;
  const options = {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + getLineBotAccessToken()
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    if (code === 200) {
      cache.put(cacheKey, '1', 600); // แคชไว้ 10 นาที
      return true;
    } else {
      cache.remove(cacheKey);
      return false;
    }
  } catch (e) {
    console.error('Error checking isUserFriendWithBot:', e);
    return false;
  }
}

/**
 * ส่งข้อความตอบกลับเตือนให้กดเพิ่มเพื่อนก่อนเข้าใช้งานแชท
 */
function replyMustAddFriendMessage(replyToken) {
  const flexMessage = {
    type: 'flex',
    altText: 'กรุณากดเพิ่มเพื่อนก่อนเข้าใช้งานแชท CM Party 2026',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#9F1239',
        background: {
          type: 'linearGradient',
          angle: '135deg',
          startColor: '#9F1239',
          centerColor: '#7F1D1D',
          centerPosition: '55%',
          endColor: '#580B24'
        },
        paddingAll: '16px',
        spacing: 'xs',
        contents: [
          {
            type: 'text',
            text: '🎄 CM PARTY 2026 • FRIEND CHECK',
            color: '#FDE68A',
            weight: 'bold',
            size: 'xxs'
          },
          {
            type: 'text',
            text: '⚠️ กรุณาเพิ่มเพื่อนก่อนใช้งานแชท',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'md'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFBF7',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FFF1F2',
            borderColor: '#F5B942',
            borderWidth: '1px',
            cornerRadius: '14px',
            paddingAll: '14px',
            spacing: 'xs',
            contents: [
              {
                type: 'text',
                text: 'คุณยังไม่ได้กดเพิ่มเพื่อนกับ LINE OA ของงาน',
                weight: 'bold',
                size: 'sm',
                color: '#881337',
                wrap: true
              },
              {
                type: 'text',
                text: 'กรุณากดปุ่ม "เพิ่มเพื่อน" (Add Friend) ที่ด้านบนของห้องแชท หรือกดปุ่มสีทองด้านล่าง เพื่อเริ่มลงทะเบียน ตรวจสอบรางวัล และส่งรูปขึ้นจอใหญ่ค่ะ ✨',
                wrap: true,
                size: 'xs',
                color: '#4C0519',
                margin: 'xs'
              }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#14532D',
        paddingAll: '14px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#D97706',
            height: 'sm',
            action: {
              type: 'uri',
              label: 'กดเพิ่มเพื่อนที่นี่ ➕',
              uri: 'https://line.me/R/ti/p/@383zmkcq'
            }
          }
        ]
      }
    }
  };

  replyLineMessage(replyToken, [withBotSender(flexMessage, 'elf')]);
}

function getLineMessageContent(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const options = {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + getLineBotAccessToken()
    },
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    throw new Error(`ไม่สามารถดึงรูปภาพจาก LINE ได้ (HTTP ${response.getResponseCode()})`);
  }
  return response.getBlob();
}

function replyLineMessage(replyToken, messages) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = {
    replyToken: replyToken,
    messages: messages
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + getLineBotAccessToken()
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  return UrlFetchApp.fetch(url, options);
}

function getTargetDriveFolder() {
  if (LINE_DRIVE_FOLDER_ID && LINE_DRIVE_FOLDER_ID.trim() !== '') {
    try {
      return DriveApp.getFolderById(LINE_DRIVE_FOLDER_ID.trim());
    } catch (e) {
      console.warn('ไม่พบ Folder ID ที่ระบุ ระบบจะใช้โฟลเดอร์เริ่มต้นแทน:', e);
    }
  }

  const folders = DriveApp.getFoldersByName(LINE_DEFAULT_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(LINE_DEFAULT_FOLDER_NAME);
}

function createWelcomeFlexMessage(profile) {
  const displayName = profile.displayName || 'ผู้ใช้งาน';
  const pictureUrl = (profile.pictureUrl && profile.pictureUrl.startsWith('https://'))
    ? profile.pictureUrl
    : 'https://cmparty.vercel.app/assets/party-logo.jpg';
  const statusMessage = profile.statusMessage || 'ยินดีต้อนรับเข้าสู่ปาร์ตี้คริสต์มาส & ปีใหม่ 2026!';

  return withBotSender({
    type: 'flex',
    altText: `🎄 ยินดีต้อนรับคุณ ${displayName} เข้าสู่ CM Party 2026!`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#9F1239',
        background: {
          type: 'linearGradient',
          angle: '135deg',
          startColor: '#9F1239',
          endColor: '#580B24'
        },
        paddingAll: '20px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#F5B942',
                cornerRadius: '20px',
                paddingStart: '10px',
                paddingEnd: '10px',
                paddingTop: '4px',
                paddingBottom: '4px',
                flex: 0,
                contents: [
                  {
                    type: 'text',
                    text: '🎄 CM PARTY 2026',
                    color: '#580B24',
                    size: 'xxs',
                    weight: 'bold'
                  }
                ]
              },
              {
                type: 'text',
                text: 'WELCOME NEW FRIEND',
                color: '#FDE68A',
                size: 'xxs',
                weight: 'bold',
                align: 'end'
              }
            ]
          },
          {
            type: 'text',
            text: 'ยินดีต้อนรับสู่ปาร์ตี้คริสต์มาส!',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg',
            align: 'center',
            margin: 'md',
            wrap: true
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFBF7',
        spacing: 'md',
        paddingAll: '20px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            alignItems: 'center',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                width: '88px',
                height: '88px',
                cornerRadius: '44px',
                borderWidth: '3px',
                borderColor: '#F5B942',
                contents: [
                  {
                    type: 'image',
                    url: pictureUrl,
                    size: 'full',
                    aspectMode: 'cover',
                    aspectRatio: '1:1'
                  }
                ]
              },
              {
                type: 'text',
                text: displayName,
                weight: 'bold',
                size: 'lg',
                color: '#881337',
                margin: 'md',
                align: 'center',
                wrap: true
              },
              {
                type: 'text',
                text: statusMessage,
                size: 'xs',
                color: '#64748B',
                margin: 'xs',
                align: 'center',
                wrap: true
              }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FFFFFF',
            borderColor: '#FECDD3',
            borderWidth: '1px',
            cornerRadius: '14px',
            paddingAll: '14px',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                text: '🎁 กิจกรรมสนุกภายในงานเลี้ยง:',
                color: '#9F1239',
                weight: 'bold',
                size: 'xs'
              },
              {
                type: 'text',
                text: '1) กด "ลงทะเบียนเข้างาน" เพื่อรับ VIP Ticket & สิทธิ์จับรางวัล',
                color: '#334155',
                size: 'xs',
                wrap: true
              },
              {
                type: 'text',
                text: '2) ส่งรูปถ่ายสวยๆ เข้าแชทนี้เพื่อขึ้นจอสไลด์โชว์',
                color: '#334155',
                size: 'xs',
                wrap: true
              },
              {
                type: 'text',
                text: '3) พิมพ์ "อวยพร", "เสี่ยงเซียมซี" หรือ "ตรวจสอบรางวัล" ได้ทันที!',
                color: '#14532D',
                weight: 'bold',
                size: 'xs',
                wrap: true
              }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#14532D',
        paddingAll: '16px',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#F5B942',
            height: 'md',
            action: {
              type: 'uri',
              label: '🎟️ ลงทะเบียนเข้างาน (VIP Pass)',
              uri: LIFF_REGISTER_URL
            }
          },
          {
            type: 'button',
            style: 'secondary',
            color: '#ECFDF5',
            height: 'sm',
            action: {
              type: 'uri',
              label: '📸 ดูแกลเลอรีภาพกิจกรรม',
              uri: GALLERY_WEB_URL
            }
          }
        ]
      }
    }
  }, 'elf');
}

/**
 * สร้าง Flex Message สวยหรูสำหรับเข้าดูแกลเลอรีภาพความประทับใจในงาน CM Party 2026
 */
function createGalleryFlexMessage() {
  let cachedCountText = 'รวมภาพบรรยากาศและความประทับใจในงาน CM Party 2026';
  try {
    const cachedJson = CacheService.getScriptCache().get('GALLERY_IMAGES_CACHE');
    if (cachedJson) {
      const parsed = JSON.parse(cachedJson);
      if (parsed && typeof parsed.total === 'number' && parsed.total > 0) {
        cachedCountText = `อัปเดตล่าสุดทั้งหมด ${parsed.total} ภาพในแกลเลอรี`;
      }
    }
  } catch (e) {}

  return withBotSender({
    type: 'flex',
    altText: '📸 ภาพความประทับใจในงาน CM Party 2026 - กดเพื่อดูรูปกิจกรรมในงาน',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#9F1239',
        background: {
          type: 'linearGradient',
          angle: '135deg',
          startColor: '#9F1239',
          endColor: '#580B24'
        },
        paddingAll: '20px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#F5B942',
                cornerRadius: '20px',
                paddingStart: '10px',
                paddingEnd: '10px',
                paddingTop: '4px',
                paddingBottom: '4px',
                flex: 0,
                contents: [
                  {
                    type: 'text',
                    text: 'CM GALLERY 2026',
                    color: '#580B24',
                    size: 'xxs',
                    weight: 'bold'
                  }
                ]
              },
              {
                type: 'text',
                text: '🎄 CHRISTMAS PARTY',
                color: '#FDE68A',
                size: 'xxs',
                weight: 'bold',
                align: 'end'
              }
            ]
          },
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            spacing: 'md',
            margin: 'lg',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                width: '60px',
                height: '60px',
                cornerRadius: '30px',
                borderWidth: '2px',
                borderColor: '#FBBF24',
                flex: 0,
                contents: [
                  {
                    type: 'image',
                    url: 'https://cmparty.vercel.app/assets/party-logo.jpg',
                    size: 'full',
                    aspectMode: 'cover',
                    aspectRatio: '1:1'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                spacing: 'xs',
                flex: 1,
                contents: [
                  {
                    type: 'text',
                    text: '📸 ภาพความประทับใจในงาน',
                    color: '#FFFFFF',
                    size: 'lg',
                    weight: 'bold',
                    wrap: true
                  },
                  {
                    type: 'text',
                    text: 'CM Party 2026 Photo Gallery',
                    color: '#FDE68A',
                    size: 'xs',
                    weight: 'bold'
                  }
                ]
              }
            ]
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        paddingAll: '20px',
        spacing: 'md',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FFFBEB',
            borderColor: '#FDE68A',
            borderWidth: '1px',
            cornerRadius: '12px',
            paddingAll: '12px',
            alignItems: 'center',
            contents: [
              {
                type: 'text',
                text: '✨ ' + cachedCountText,
                color: '#B45309',
                size: 'xs',
                weight: 'bold',
                align: 'center',
                wrap: true
              }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FEF2F2',
            borderColor: '#FECACA',
            borderWidth: '1px',
            cornerRadius: '14px',
            paddingAll: '14px',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                text: '🎄 ชมภาพความสนุก รอยยิ้ม และบรรยากาศภายในงาน',
                color: '#7F1D1D',
                size: 'xs',
                weight: 'bold',
                wrap: true
              },
              {
                type: 'text',
                text: '🎬 รองรับโหมดสไลด์โชว์และอัปเดตรูปใหม่แบบเรียลไทม์',
                color: '#374151',
                size: 'xs',
                wrap: true
              },
              {
                type: 'text',
                text: '📱 ส่งรูปภาพเข้าแชทนี้เพื่อร่วมแบ่งปันโมเมนต์สวย ๆ ได้เลย!',
                color: '#15803D',
                size: 'xs',
                weight: 'bold',
                wrap: true
              }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#14532D',
        paddingAll: '16px',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            backgroundColor: '#F59E0B',
            background: {
              type: 'linearGradient',
              angle: '135deg',
              startColor: '#FEF08A',
              centerColor: '#F59E0B',
              centerPosition: '50%',
              endColor: '#D97706'
            },
            borderColor: '#FEF9C3',
            borderWidth: '2px',
            cornerRadius: '28px',
            paddingTop: '13px',
            paddingBottom: '13px',
            paddingStart: '18px',
            paddingEnd: '18px',
            alignItems: 'center',
            justifyContent: 'center',
            action: {
              type: 'uri',
              label: 'ดูรูปกิจกรรมในงาน',
              uri: GALLERY_WEB_URL
            },
            contents: [
              {
                type: 'text',
                text: '📸',
                size: 'md',
                flex: 0
              },
              {
                type: 'text',
                text: 'ดูรูปกิจกรรมในงาน',
                color: '#450A0A',
                size: 'md',
                weight: 'bold',
                margin: 'sm',
                flex: 0
              },
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#991B1B',
                cornerRadius: '14px',
                paddingStart: '9px',
                paddingEnd: '9px',
                paddingTop: '3px',
                paddingBottom: '3px',
                margin: 'md',
                flex: 0,
                contents: [
                  {
                    type: 'text',
                    text: 'เปิดดู →',
                    color: '#FEF08A',
                    size: 'xxs',
                    weight: 'bold'
                  }
                ]
              }
            ]
          },
          {
            type: 'text',
            text: 'แตะปุ่มด้านบนเพื่อเปิดดูแกลเลอรีภาพกิจกรรม CM Party 2026',
            color: '#BBF7D0',
            size: 'xxs',
            align: 'center',
            margin: 'xs',
            wrap: true
          }
        ]
      }
    }
  }, 'photo');
}

// ==========================================
// 13. ระบบติดตั้งและรีเซ็ต LINE Rich Menu 6 ช่องอัตโนมัติ (LINE Messaging API)
// ==========================================
const RICH_MENU_NAME = 'CM Party 2026 Rich Menu';
const RICH_MENU_PROP_KEY = 'ACTIVE_CM_PARTY_RICH_MENU_ID';
const PREVIOUS_RICH_MENU_PROP_KEY = 'PREVIOUS_API_RICH_MENU_ID';
const RICH_MENU_IMAGE_URLS = [
  'https://cmparty.vercel.app/assets/line-rich-menu-2500x1686.jpg',
  'https://raw.githubusercontent.com/itsupportcm2/cmparty/main/assets/line-rich-menu-2500x1686.jpg'
];

function callLineMessagingApi(url, method, token, payload, contentType) {
  const options = {
    method: method,
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true
  };
  if (contentType) {
    options.contentType = contentType;
  }
  if (payload !== undefined && payload !== null) {
    options.payload = payload;
  }
  const res = UrlFetchApp.fetch(url, options);
  return {
    code: res.getResponseCode(),
    body: res.getContentText()
  };
}

function getCurrentDefaultRichMenuId(token) {
  const res = callLineMessagingApi('https://api.line.me/v2/bot/user/all/richmenu', 'get', token);
  if (res.code === 404) return '';
  if (res.code >= 200 && res.code < 300) {
    const parsed = JSON.parse(res.body || '{}');
    return String(parsed.richMenuId || '').trim();
  }
  throw new Error(`ดึง Default Rich Menu ไม่สำเร็จ (${res.code}): ${res.body}`);
}

function listApiRichMenus(token) {
  const res = callLineMessagingApi('https://api.line.me/v2/bot/richmenu/list', 'get', token);
  if (res.code < 200 || res.code >= 300) {
    throw new Error(`ดึงรายการ Rich Menu จาก API ไม่สำเร็จ (${res.code}): ${res.body}`);
  }
  const parsed = JSON.parse(res.body || '{}');
  return Array.isArray(parsed.richmenus) ? parsed.richmenus : [];
}

function fetchRichMenuImageBlob() {
  const errors = [];
  for (let i = 0; i < RICH_MENU_IMAGE_URLS.length; i++) {
    const imgUrl = RICH_MENU_IMAGE_URLS[i];
    const bustUrl = imgUrl + (imgUrl.indexOf('?') === -1 ? '?_t=' : '&_t=') + Date.now();
    try {
      const res = UrlFetchApp.fetch(bustUrl, { muteHttpExceptions: true });
      const code = res.getResponseCode();
      if (code >= 200 && code < 300) {
        const blob = res.getBlob();
        const bytes = blob.getBytes();
        if (bytes && bytes.length > 10000 && bytes.length < 1048576) {
          return blob;
        }
        errors.push(`${imgUrl} (invalid size=${bytes ? bytes.length : 0})`);
      } else {
        errors.push(`${imgUrl} (HTTP ${code})`);
      }
    } catch (err) {
      errors.push(`${imgUrl} (${err.message})`);
    }
  }
  throw new Error('ไม่สามารถดาวน์โหลดไฟล์ภาพ Rich Menu ได้: ' + errors.join('; '));
}

function deleteRichMenusMatching(token, shouldDeleteFn) {
  let menus = [];
  try {
    menus = listApiRichMenus(token);
  } catch (err) {
    return { deletedCount: 0, deletedIds: [] };
  }
  const deletedIds = [];
  for (let i = 0; i < menus.length; i++) {
    const rm = menus[i];
    if (rm && rm.richMenuId && shouldDeleteFn(rm)) {
      const delRes = callLineMessagingApi(
        'https://api.line.me/v2/bot/richmenu/' + rm.richMenuId,
        'delete',
        token
      );
      if (delRes.code >= 200 && delRes.code < 300) {
        deletedIds.push(rm.richMenuId);
      }
    }
  }
  return { deletedCount: deletedIds.length, deletedIds: deletedIds };
}

const CURRENT_GAS_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbx6yDgQvf3RvCVu8nHRN3yQM6IM5Be2JZpESNT6nJ3XddDsOlrMj_S7nIPCRUqmZBjFYw/exec';

function getLineWebhookEndpointInfo(token) {
  try {
    const res = callLineMessagingApi('https://api.line.me/v2/bot/channel/webhook/endpoint', 'get', token);
    if (res.code >= 200 && res.code < 300) {
      return JSON.parse(res.body || '{}');
    }
    return { error: `HTTP ${res.code}: ${res.body}` };
  } catch (err) {
    return { error: err.message };
  }
}

function validateLineReplyMessageObj(token, msgObj) {
  try {
    const res = callLineMessagingApi(
      'https://api.line.me/v2/bot/message/validate/reply',
      'post',
      token,
      JSON.stringify({ messages: [msgObj] }),
      'application/json'
    );
    return { valid: res.code >= 200 && res.code < 300, code: res.code, body: res.body || 'OK' };
  } catch (err) {
    return { valid: false, code: 0, body: err.message };
  }
}

/**
 * ตรวจสอบ Rich Menu ปัจจุบันใน LINE Official Account ว่ามาจาก LINE OA Manager หรือ Messaging API
 */
function inspectLineRichMenus(params) {
  const token = getLineBotAccessToken();
  if (!token) {
    return { status: 'error', message: 'ไม่พบ LINE_BOT_ACCESS_TOKEN ใน Script Properties' };
  }

  try {
    const props = PropertiesService.getScriptProperties();
    let webhookInfo = getLineWebhookEndpointInfo(token);
    let webhookUpdated = false;
    if (params && String(params.syncWebhook || '') === '1') {
      const putRes = callLineMessagingApi(
        'https://api.line.me/v2/bot/channel/webhook/endpoint',
        'put',
        token,
        JSON.stringify({ endpoint: CURRENT_GAS_WEBHOOK_URL }),
        'application/json'
      );
      webhookUpdated = putRes.code >= 200 && putRes.code < 300;
      webhookInfo = getLineWebhookEndpointInfo(token);
    }

    const defaultRichMenuId = getCurrentDefaultRichMenuId(token);
    const rawMenus = listApiRichMenus(token);
    const apiMenus = rawMenus.map(rm => ({
      richMenuId: rm.richMenuId || '',
      name: rm.name || '',
      chatBarText: rm.chatBarText || '',
      selected: Boolean(rm.selected),
      size: rm.size || null,
      isCurrentDefault: Boolean(defaultRichMenuId && rm.richMenuId === defaultRichMenuId),
      areas: Array.isArray(rm.areas) ? rm.areas : []
    }));

    const activeCmPartyMenuId = String(props.getProperty(RICH_MENU_PROP_KEY) || '').trim();
    const previousApiMenuId = String(props.getProperty(PREVIOUS_RICH_MENU_PROP_KEY) || '').trim();

    let sourceSummary = '';
    if (!defaultRichMenuId && apiMenus.length === 0) {
      sourceSummary = 'ไม่มี Rich Menu จาก Messaging API เลย (หากเห็นเมนูในแชท มาจากเว็บ LINE Official Account Manager: manager.line.biz 100%)';
    } else if (!defaultRichMenuId) {
      sourceSummary = 'ไม่มี Default Rich Menu จาก API (เมนูที่แสดงในแชทตอนนี้มาจาก manager.line.biz แต่มีเมนูค้างอยู่ใน API ' + apiMenus.length + ' รายการ)';
    } else {
      const activeMenu = apiMenus.find(m => m.richMenuId === defaultRichMenuId);
      const activeName = (activeMenu && activeMenu.name) || defaultRichMenuId;
      sourceSummary = activeName === RICH_MENU_NAME
        ? `กำลังแสดงเมนู "${RICH_MENU_NAME}" จากระบบ CM Party (API ID: ${defaultRichMenuId})`
        : `กำลังแสดงเมนูที่สร้างจาก Messaging API เดิม ชื่อ "${activeName}" (ID: ${defaultRichMenuId})`;
    }

    const flexValidation = {
      fortune: validateLineReplyMessageObj(token, buildNewYearFortuneMessage('')),
      partyMenu: validateLineReplyMessageObj(token, buildPartyMenuFlexMessage(buildWishSentQuickReply())),
      gallery: validateLineReplyMessageObj(token, createGalleryFlexMessage()),
      welcome: validateLineReplyMessageObj(token, createWelcomeFlexMessage({ displayName: 'ทดสอบ', pictureUrl: 'https://cmparty.vercel.app/assets/party-logo.jpg', statusMessage: 'Hello' }))
    };

    return {
      status: 'success',
      webhookInfo: webhookInfo,
      webhookMatchesCurrentDeploy: Boolean(webhookInfo && webhookInfo.endpoint === CURRENT_GAS_WEBHOOK_URL),
      webhookUpdated: webhookUpdated,
      flexValidation: flexValidation,
      defaultRichMenuId: defaultRichMenuId || null,
      apiMenuCount: apiMenus.length,
      apiMenus: apiMenus,
      activeCmPartyMenuId: activeCmPartyMenuId || null,
      previousApiMenuId: previousApiMenuId || null,
      sourceSummary: sourceSummary
    };
  } catch (err) {
    console.error('Error in inspectLineRichMenus:', err);
    return { status: 'error', message: err.message };
  }
}

/**
 * ติดตั้ง LINE Rich Menu ขนาด 2500x1686 (6 ช่อง) และตั้งเป็น Default Rich Menu สำหรับผู้ใช้ทุกคน
 * สามารถรันตรงจาก Apps Script Editor, หน้าแอดมิน (index.html) หรือพิมพ์ "เปิดริชเมนู" ในแชทแอดมินได้
 */
function setupLineRichMenu() {
  const token = getLineBotAccessToken();
  if (!token) {
    return { status: 'error', message: 'ไม่พบ LINE_BOT_ACCESS_TOKEN ใน Script Properties' };
  }

  let createdMenuId = '';
  try {
    const props = PropertiesService.getScriptProperties();

    // 0. สำรอง Default API Rich Menu เดิม (ถ้ามีและไม่ใช่ของ CM Party 2026) เพื่อคืนค่าได้อัตโนมัติภายหลัง
    let preservedPrevId = '';
    try {
      const existingDefaultId = getCurrentDefaultRichMenuId(token);
      if (existingDefaultId) {
        const existingMenus = listApiRichMenus(token);
        const matched = existingMenus.find(m => m.richMenuId === existingDefaultId);
        if (matched && matched.name !== RICH_MENU_NAME) {
          props.setProperty(PREVIOUS_RICH_MENU_PROP_KEY, existingDefaultId);
          preservedPrevId = existingDefaultId;
        }
      }
    } catch (backupErr) {}

    // 1. ดาวน์โหลดรูปภาพ Rich Menu 2500x1686 ก่อนเพื่อป้องกันการสร้างเมนูค้างหากโหลดภาพไม่ผ่าน
    const imageBlob = fetchRichMenuImageBlob();

    // 2. สร้างโครงสร้าง Rich Menu 6 ช่อง (3 คอลัมน์ x 2 แถว)
    const richMenuDef = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: RICH_MENU_NAME,
      chatBarText: 'เมนู CM Party',
      areas: [
        {
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: { type: 'uri', label: 'ลงทะเบียนเข้างาน', uri: LIFF_REGISTER_URL }
        },
        {
          bounds: { x: 833, y: 0, width: 834, height: 843 },
          action: { type: 'message', label: 'ตรวจสอบรางวัล', text: 'ตรวจสอบรางวัล' }
        },
        {
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: { type: 'message', label: 'ภาพกิจกรรมในงาน', text: 'ภาพกิจกรรมในงาน' }
        },
        {
          bounds: { x: 0, y: 843, width: 833, height: 843 },
          action: { type: 'message', label: 'ส่งคำอวยพรขึ้นจอ', text: 'อวยพรขึ้นจอ' }
        },
        {
          bounds: { x: 833, y: 843, width: 834, height: 843 },
          action: { type: 'message', label: 'เสี่ยงเซียมซี 2026', text: 'เสี่ยงเซียมซี' }
        },
        {
          bounds: { x: 1667, y: 843, width: 833, height: 843 },
          action: { type: 'message', label: 'เมนูสนุกและส่งรูป', text: 'เมนู' }
        }
      ]
    };

    const createRes = callLineMessagingApi(
      'https://api.line.me/v2/bot/richmenu',
      'post',
      token,
      JSON.stringify(richMenuDef),
      'application/json'
    );
    if (createRes.code < 200 || createRes.code >= 300) {
      throw new Error(`สร้าง Rich Menu ไม่สำเร็จ (${createRes.code}): ${createRes.body}`);
    }
    const createdJson = JSON.parse(createRes.body || '{}');
    createdMenuId = String(createdJson.richMenuId || '').trim();
    if (!createdMenuId) {
      throw new Error('LINE API ไม่ได้ส่ง richMenuId กลับมา');
    }

    // 3. อัปโหลดไฟล์ภาพ JPEG เข้า richMenuId ที่เพิ่งสร้าง
    const uploadRes = callLineMessagingApi(
      'https://api-data.line.me/v2/bot/richmenu/' + createdMenuId + '/content',
      'post',
      token,
      imageBlob.getBytes(),
      'image/jpeg'
    );
    if (uploadRes.code < 200 || uploadRes.code >= 300) {
      throw new Error(`อัปโหลดรูป Rich Menu ไม่สำเร็จ (${uploadRes.code}): ${uploadRes.body}`);
    }

    // 4. ตั้งเป็น Default Rich Menu สำหรับทุกคน
    const defaultRes = callLineMessagingApi(
      'https://api.line.me/v2/bot/user/all/richmenu/' + createdMenuId,
      'post',
      token
    );
    if (defaultRes.code < 200 || defaultRes.code >= 300) {
      throw new Error(`ตั้งค่า Default Rich Menu ไม่สำเร็จ (${defaultRes.code}): ${defaultRes.body}`);
    }

    // 5. ลบ Rich Menu เวอร์ชันเก่าที่มีชื่อเดียวกันออกเพื่อลดขยะในโควตา API (ไม่แตะชื่ออื่น)
    const cleanup = deleteRichMenusMatching(
      token,
      rm => rm.name === RICH_MENU_NAME && rm.richMenuId !== createdMenuId
    );

    props.setProperty(RICH_MENU_PROP_KEY, createdMenuId);

    return {
      status: 'success',
      richMenuId: createdMenuId,
      preservedPreviousApiMenuId: preservedPrevId || null,
      cleanedOldCount: cleanup.deletedCount,
      message: 'ติดตั้งและเปิดใช้งาน LINE Rich Menu 6 ช่องเรียบร้อยแล้ว!'
    };
  } catch (err) {
    if (createdMenuId) {
      try {
        callLineMessagingApi('https://api.line.me/v2/bot/richmenu/' + createdMenuId, 'delete', token);
      } catch (cleanupErr) {}
    }
    console.error('Error in setupLineRichMenu:', err);
    return { status: 'error', message: err.message };
  }
}

/**
 * ยกเลิก Default Rich Menu จาก API, ลบ Rich Menu ของ CM Party 2026 และคืนค่า Rich Menu เดิมอัตโนมัติ
 */
function clearLineRichMenu() {
  const token = getLineBotAccessToken();
  if (!token) {
    return { status: 'error', message: 'ไม่พบ LINE_BOT_ACCESS_TOKEN ใน Script Properties' };
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const storedId = String(props.getProperty(RICH_MENU_PROP_KEY) || '').trim();
    const prevApiId = String(props.getProperty(PREVIOUS_RICH_MENU_PROP_KEY) || '').trim();

    const unlinkRes = callLineMessagingApi(
      'https://api.line.me/v2/bot/user/all/richmenu',
      'delete',
      token
    );
    if (unlinkRes.code >= 400 && unlinkRes.code !== 404) {
      throw new Error(`ยกเลิก Default Rich Menu ไม่สำเร็จ (${unlinkRes.code}): ${unlinkRes.body}`);
    }

    const cleanup = deleteRichMenusMatching(
      token,
      rm => rm.name === RICH_MENU_NAME || (storedId && rm.richMenuId === storedId)
    );
    let totalDeleted = cleanup.deletedCount;

    if (storedId && cleanup.deletedIds.indexOf(storedId) === -1) {
      const delStored = callLineMessagingApi(
        'https://api.line.me/v2/bot/richmenu/' + storedId,
        'delete',
        token
      );
      if (delStored.code >= 200 && delStored.code < 300) {
        totalDeleted++;
      }
    }

    props.deleteProperty(RICH_MENU_PROP_KEY);

    // หากเคยมี Default API Rich Menu เดิมเก็บไว้ ให้สลับกลับมาใช้งานให้อัตโนมัติ
    let restoredPreviousMenuId = '';
    if (prevApiId) {
      try {
        const remaining = listApiRichMenus(token);
        if (remaining.some(m => m.richMenuId === prevApiId)) {
          const restoreRes = callLineMessagingApi(
            'https://api.line.me/v2/bot/user/all/richmenu/' + prevApiId,
            'post',
            token
          );
          if (restoreRes.code >= 200 && restoreRes.code < 300) {
            restoredPreviousMenuId = prevApiId;
          }
        }
      } catch (restoreErr) {}
      props.deleteProperty(PREVIOUS_RICH_MENU_PROP_KEY);
    }

    return {
      status: 'success',
      deletedCount: totalDeleted,
      restoredPreviousMenuId: restoredPreviousMenuId || null,
      message: restoredPreviousMenuId
        ? 'ปิด Rich Menu งานปาร์ตี้และสลับกลับไปใช้ API Rich Menu เดิมให้เรียบร้อยแล้ว!'
        : 'ปิดและลบ LINE Rich Menu ออกจาก API แล้ว (สามารถกลับไปใช้เมนูจาก LINE OA Manager ได้ตามปกติ)'
    };
  } catch (err) {
    console.error('Error in clearLineRichMenu:', err);
    return { status: 'error', message: err.message };
  }
}

function adminSetupLineRichMenu(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'forbidden', message: 'ไม่มีสิทธิ์ดำเนินการ (เฉพาะแอดมินเท่านั้น)' };
  }
  return setupLineRichMenu();
}

function adminClearLineRichMenu(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'forbidden', message: 'ไม่มีสิทธิ์ดำเนินการ (เฉพาะแอดมินเท่านั้น)' };
  }
  return clearLineRichMenu();
}

function adminInspectLineRichMenus(payload) {
  if (!isAdminAuthorized(payload)) {
    return { status: 'forbidden', message: 'ไม่มีสิทธิ์เข้าถึงข้อมูล Rich Menu (เฉพาะแอดมินเท่านั้น)' };
  }
  return inspectLineRichMenus(payload);
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
