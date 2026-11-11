// ==========================================
// ระบบรวมศูนย์ CM Party:
// - LINE Bot Webhook (ต้อนรับเพื่อนใหม่, อัปโหลดรูปลง Google Drive, พิมพ์ "ตรวจสอบรางวัล" ค้นหาจาก Sheet gift)
// - ระบบลงทะเบียนเข้างานเลี้ยง (index.html -> Sheet "Register")
// - ระบบบันทึกและจัดการรางวัล (reward.html -> Sheet "gift" + LINE Push Flex Message)
// ==========================================
const LINE_BOT_ACCESS_TOKEN = 'ZUF3tyAspwl3dVgo+5YSqfJZpu1fA438z3vIyHmga+Jre+ZuWrg30Xj1qV4ews6AG+RLY/FiaC+L6lkk6HoEHsed4ZYB7NMMS6n+rWxcpulnh3V7SAohcUx1+84NR8niEI41u5zLf3hlRm5jvKkWIAdB04t89/1O/w1cDnyilFU=';
const LINE_DRIVE_FOLDER_ID = '1Mob3ioDYe_67dLNHp3zQR4tGl2EtFJ-L';
const LINE_DEFAULT_FOLDER_NAME = 'LINE_Bot_Uploads';

const SPREADSHEET_ID = '1j2wb2cBiPK2IDfpNKJZBSUu3MDVwSEogAkRENvU-GJw';
const SOURCE_SHEET_NAME = 'การตอบแบบฟอร์ม 1';
const TARGET_SHEET_NAME = 'Register';
const GIFT_SHEET_NAME = 'gift';
const REWARD_SHEET_GID = 195154721;

// บัญชีแอดมินสำหรับจัดการเปิด-ปิดระบบลงทะเบียน
const ADMIN_UID = 'U1dcbd47c6981745c2f41c5691cde7ff3';

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
 * บันทึกการกำหนดวันเวลาเปิด-ปิดระบบ หรือเปิด/ปิดระบบลงทะเบียนทันที (เฉพาะ Admin UID เท่านั้น)
 */
function setRegistrationSchedule(openingDateTime, closingDateTime, requesterUid, manualStatus) {
  const cleanUid = String(requesterUid || '').trim();
  if (cleanUid !== ADMIN_UID) {
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
      'Authorization': 'Bearer ' + LINE_BOT_ACCESS_TOKEN
    },
    muteHttpExceptions: true
  });
  Logger.log('✅ ทดสอบสิทธิ์ UrlFetchApp.fetch (LINE Bot Info) สำเร็จ! HTTP ' + response.getResponseCode() + ': ' + response.getContentText());
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
    // Index 0 = A (ประทับเวลา)
    // Index 1 = B (รหัสพนักงาน)
    // Index 2 = C (ชื่อ-สกุล หรือ แผนก)
    // Index 3 = D (แผนก หรือ ชื่อ-สกุล)
    // Index 4 = E (สาขา)
    // Index 5 = F (ท่านสนใจร่วมงานหรือไม่?)
    const maxCols = Math.max(6, sourceSheet.getLastColumn());
    const data = sourceSheet.getRange(2, 1, lastRow - 1, maxCols).getValues();
    const headers = sourceSheet.getRange(1, 1, 1, maxCols).getValues()[0];

    // ค้นหาคอลัมน์ "ท่านสนใจร่วมงานหรือไม่?" โดยอัตโนมัติ (ปกติคือคอลัมน์ F / index 5)
    let attendColIdx = 5;
    for (let h = 0; h < headers.length; h++) {
      const hText = String(headers[h] || '').trim();
      if (hText.indexOf('สนใจร่วมงาน') !== -1 || hText.indexOf('ร่วมงานหรือไม่') !== -1) {
        attendColIdx = h;
        break;
      }
    }

    let foundEmployee = null;
    for (let i = data.length - 1; i >= 0; i--) {
      const row = data[i];
      const rowEmpId = String(row[1] || '').trim().replace(/\.0$/, '');
      const rowColC = String(row[2] || '').trim(); // แผนก (หรือชื่อ-สกุล ตามโครงสร้างฟอร์ม)
      const rowColD = String(row[3] || '').trim(); // ชื่อ-สกุล (หรือแผนก)
      const rowColE = String(row[4] || '').trim(); // สาขา

      if (rowEmpId === searchId) {
        // ตรวจสอบว่าคอลัมน์ C หรือ D เป็นแผนก/ชื่อ เพื่อให้แสดงผลได้ถูกต้องทั้ง 2 กรณี
        const headerC = String(headers[2] || '');
        const headerD = String(headers[3] || '');

        let empName = rowColD;
        let department = rowColC;

        // หากหัวคอลัมน์ C มีคำว่า "ชื่อ" และคอลัมน์ D มีคำว่า "แผนก" ให้ดึงตามคอลัมน์จริงเพื่อไม่ให้ข้อมูลสลับช่อง
        if (headerC.indexOf('ชื่อ') !== -1 && headerD.indexOf('แผนก') !== -1) {
          empName = rowColC;
          department = rowColD;
        }

        const rawAttend = String(row[attendColIdx] || '').trim();
        // ถ้ามีคำว่า "ไม่" หรือไม่มีคำว่า "ไป" ให้ถือว่าไม่มาร่วมงาน
        const isNotAttending = rawAttend.indexOf('ไม่') !== -1 || (rawAttend.indexOf('ไป') === -1 && rawAttend !== '');

        foundEmployee = {
          empId: rowEmpId,
          empName: empName,
          department: department,
          branch: rowColE,
          attendAnswer: rawAttend,
          isNotAttending: isNotAttending
        };
        break;
      }
    }

    if (!foundEmployee) {
      return { status: 'not_found', message: 'ไม่พบรหัสพนักงานนี้ในรายชื่อตั้งต้น' };
    }

    // ตรวจสอบคอลัมน์ "ท่านสนใจร่วมงานหรือไม่?" หากตอบ "ไม่ไป" หรือไม่มาร่วมงาน ไม่อนุญาตให้ลงทะเบียน
    if (foundEmployee.isNotAttending) {
      return {
        status: 'not_attending',
        message: 'ท่านไม่ได้มาร่วมงานลงทะเบียนไม่ได้',
        data: foundEmployee
      };
    }

    // ตรวจสอบว่าลงทะเบียนไปแล้วหรือยังใน Sheet Register
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
 * บันทึกข้อมูลการลงทะเบียนลงใน Sheet "Register"
 */
function saveRegistrationData(payload) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

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

    // ตรวจสอบสถานะการเปิด-ปิดระบบลงทะเบียน
    const sysStatusInfo = getRegistrationSystemStatus();
    if (!sysStatusInfo.isOpen && uid !== ADMIN_UID) {
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

    // ตรวจสอบสถานะการเข้าร่วมงานและตรวจสอบรหัสพนักงานซ้ำจากแบบฟอร์มตั้งต้น + Sheet Register
    const empCheck = checkEmployeeById(empId);
    if (empCheck && empCheck.status === 'not_attending') {
      return { status: 'error', message: 'ท่านไม่ได้มาร่วมงานลงทะเบียนไม่ได้' };
    }
    if (empCheck && empCheck.alreadyRegistered) {
      return {
        status: 'duplicate',
        message: 'รหัสพนักงานนี้ได้ลงทะเบียนไปแล้ว'
      };
    }

    // ตรวจสอบว่าผู้ใช้กดเพิ่มเพื่อนกับ LINE Official Account แล้วหรือไม่
    if (uid && uid !== 'TEST_USER' && !isUserFriendWithBot(uid, true)) {
      return { status: 'error', message: 'กรุณากดเพิ่มเพื่อน LINE กับ cmparty2026 ก่อนทำการลงทะเบียน' };
    }

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let regSheet = getSheetSafely(ss, TARGET_SHEET_NAME);

    // หากยังไม่มี Sheet Register ให้สร้างใหม่
    if (!regSheet) {
      regSheet = ss.insertSheet(TARGET_SHEET_NAME);
    }

    // ตรวจสอบหัวคอลัมน์แถวที่ 1 หากแผ่นงานยังว่างเปล่า หรือแถวที่ 1 ยังไม่มีหัวคอลัมน์ ให้สร้าง Header อัตโนมัติพร้อมตกแต่งสี
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
      // ตรวจสอบการลงทะเบียนซ้ำด้วยรหัสพนักงาน (เช็คก่อนเสมอ) และ LINE UID
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

    // ส่ง Flex Message บัตรยืนยันการลงทะเบียนเข้าแชท LINE ของผู้ลงทะเบียนทันทีผ่าน LINE Push API
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
    lock.releaseLock();
  }
}

/**
 * ส่ง LINE Push Message (Flex Message บัตรเข้างาน VIP Pass) แจ้งยืนยันการลงทะเบียนสำเร็จเข้าแชทของผู้ลงทะเบียนโดยตรง
 */
function pushRegistrationFlexMessage(uid, info) {
  const token = (typeof LINE_BOT_ACCESS_TOKEN !== 'undefined' && LINE_BOT_ACCESS_TOKEN)
    ? LINE_BOT_ACCESS_TOKEN
    : 'ZUF3tyAspwl3dVgo+5YSqfJZpu1fA438z3vIyHmga+Jre+ZuWrg30Xj1qV4ews6AG+RLY/FiaC+L6lkk6HoEHsed4ZYB7NMMS6n+rWxcpulnh3V7SAohcUx1+84NR8niEI41u5zLf3hlRm5jvKkWIAdB04t89/1O/w1cDnyilFU=';

  const profilePic = (info.pictureUrl && String(info.pictureUrl).indexOf('https://') === 0)
    ? String(info.pictureUrl)
    : 'https://cdn-icons-png.flaticon.com/512/847/847969.png';

  const lineName = String(info.displayName || 'ผู้เข้าร่วมงาน');
  const empName = String(info.empName || '-');
  const empId = String(info.empId || '-');
  const department = String(info.department || '-');
  const branch = String(info.branch || '-');
  const timestamp = String(info.timestamp || Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss'));

  const ticketFlexMessage = {
    type: 'flex',
    altText: `บัตรเข้างาน CM Party - ${empName} (รหัส ${empId}) ลงทะเบียนสำเร็จแล้ว`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#991B1B',
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
                backgroundColor: '#FBBF24',
                cornerRadius: '20px',
                paddingStart: '10px',
                paddingEnd: '10px',
                paddingTop: '4px',
                paddingBottom: '4px',
                flex: 0,
                contents: [
                  {
                    type: 'text',
                    text: 'VIP PASS',
                    color: '#78350F',
                    size: 'xxs',
                    weight: 'bold'
                  }
                ]
              },
              {
                type: 'text',
                text: 'CHRISTMAS & NEW YEAR',
                color: '#FDE68A',
                size: 'xxs',
                weight: 'bold',
                align: 'end'
              }
            ]
          },
          {
            type: 'text',
            text: 'CM PARTY TICKET',
            color: '#FFFFFF',
            size: 'xl',
            weight: 'bold',
            margin: 'md'
          },
          {
            type: 'text',
            text: 'บัตรยืนยันการลงทะเบียนเข้างานเลี้ยงสำเร็จแล้ว',
            color: '#FECACA',
            size: 'xs',
            margin: 'xs'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FFFFFF',
        paddingAll: '20px',
        spacing: 'lg',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'md',
            alignItems: 'center',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                width: '68px',
                height: '68px',
                cornerRadius: '34px',
                borderWidth: '3px',
                borderColor: '#15803D',
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
                        backgroundColor: '#DCFCE7',
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
                            color: '#15803D',
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
                    size: 'lg',
                    color: '#111827',
                    wrap: true
                  },
                  {
                    type: 'text',
                    text: 'LINE: ' + lineName,
                    size: 'xs',
                    color: '#6B7280',
                    wrap: true
                  }
                ]
              }
            ]
          },
          {
            type: 'separator',
            color: '#E5E7EB'
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#FEFCE8',
            cornerRadius: '12px',
            paddingAll: '14px',
            spacing: 'sm',
            borderWidth: '1px',
            borderColor: '#FDE68A',
            contents: [
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: 'รหัสพนักงาน',
                    color: '#92400E',
                    size: 'xs',
                    flex: 4
                  },
                  {
                    type: 'text',
                    text: empId,
                    color: '#B91C1C',
                    size: 'sm',
                    weight: 'bold',
                    flex: 6,
                    wrap: true
                  }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: 'แผนก',
                    color: '#92400E',
                    size: 'xs',
                    flex: 4
                  },
                  {
                    type: 'text',
                    text: department,
                    color: '#1F2937',
                    size: 'xs',
                    weight: 'bold',
                    flex: 6,
                    wrap: true
                  }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: 'สาขา',
                    color: '#92400E',
                    size: 'xs',
                    flex: 4
                  },
                  {
                    type: 'text',
                    text: branch,
                    color: '#15803D',
                    size: 'xs',
                    weight: 'bold',
                    flex: 6,
                    wrap: true
                  }
                ]
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
        spacing: 'xs',
        contents: [
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
      }
    }
  };

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

    if (!bypassCache) {
      const cachedData = cache.get(cacheKey);
      if (cachedData) {
        try {
          return JSON.parse(cachedData);
        } catch (cErr) {}
      }
    }

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

          // พยายามตั้งค่าแชร์ไฟล์เป็นสาธารณะ (Anyone with link view) เพื่อให้ lh5 โหลดภาพได้
          try {
            if (file.getSharingAccess() !== DriveApp.Access.ANYONE_WITH_LINK) {
              file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            }
          } catch (shareErr) {}

          const createdDate = file.getDateCreated();
          const formattedDate = createdDate
            ? Utilities.formatDate(createdDate, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss')
            : '';

          images.push({
            id: fileId,
            name: name,
            size: file.getSize(),
            date: formattedDate,
            timestamp: createdDate ? createdDate.getTime() : 0,
            url: `https://lh5.googleusercontent.com/d/${fileId}`,
            fallbackUrl: `https://lh3.googleusercontent.com/d/${fileId}`,
            thumbnailUrl: `https://lh5.googleusercontent.com/d/${fileId}=w800`,
            driveThumbnailUrl: `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`,
            driveViewUrl: file.getUrl() || `https://drive.google.com/file/d/${fileId}/view`
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

    // เรียงลำดับจากรูปล่าสุดไปหารูปแรกสุด (ใหม่สุดอยู่บน)
    images.sort((a, b) => b.timestamp - a.timestamp);

    const result = {
      status: 'success',
      total: images.length,
      folderId: folder.getId(),
      folderName: folder.getName(),
      folderUrl: `https://drive.google.com/drive/folders/${folder.getId()}?usp=sharing`,
      images: images,
      fetchedAt: Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss')
    };

    // จำผลลัพธ์ลง Cache 30 วินาทีเพื่อความรวดเร็ว
    try {
      const jsonStr = JSON.stringify(result);
      if (jsonStr.length < 95000) {
        cache.put(cacheKey, jsonStr, 30);
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

  // กรณีตรวจสอบสถานะเปิด-ปิดระบบลงทะเบียน: ?action=getSystemStatus&uid=...
  if (params.action === 'getSystemStatus') {
    const requesterUid = String(params.uid || '').trim();
    const statusInfo = getRegistrationSystemStatus();
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      ...statusInfo,
      isAdmin: requesterUid === ADMIN_UID,
      serverTime: new Date().toISOString()
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีแอดมินตั้งวันเวลาเปิด-ปิดระบบ หรือสลับเปิด-ปิดระบบ
  if (params.action === 'setSchedule' || params.action === 'setClosingDateTime' || params.action === 'toggleSystemStatus') {
    const adminUid = String(params.adminUid || params.uid || '').trim();
    const openingDateTime = params.openingDateTime !== undefined ? params.openingDateTime : null;
    const closingDateTime = params.closingDateTime !== undefined ? params.closingDateTime : null;
    const manualStatus = params.targetStatus ? String(params.targetStatus) : null;
    const res = setRegistrationSchedule(openingDateTime, closingDateTime, adminUid, manualStatus);
    return ContentService.createTextOutput(JSON.stringify(res))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีบันทึกข้อมูลผ่าน GET API (Fallback): ?action=saveRegistration&empId=...
  if (params.action === 'saveRegistration') {
    const saveResult = saveRegistrationData(params);
    return ContentService.createTextOutput(JSON.stringify(saveResult))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // กรณีสร้างหัวคอลัมน์ผ่าน GET API: ?action=initHeaders
  if (params.action === 'initHeaders') {
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
  // - ?action=getRewardInitData (ดึงรายการรางวัล + รายชื่อพนักงานจาก Sheet Register ทั้งหมดในครั้งเดียว)
  // - ?action=checkRegisteredEmployee&empId=... (ค้นหาผู้ลงทะเบียนจาก Sheet Register เท่านั้น)
  // - ?action=getRewards
  // - ?action=saveReward&rowIndex=...&rewardName=...&empId=...
  // - ?action=deleteReward&rowIndex=...
  if (params.action === 'getRewardInitData') {
    return ContentService.createTextOutput(JSON.stringify(getRewardInitData()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'checkRegisteredEmployee') {
    return ContentService.createTextOutput(JSON.stringify(checkRegisteredEmployeeById(params.empId)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'getRewards') {
    return ContentService.createTextOutput(JSON.stringify(getRewardsList()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'saveReward') {
    return ContentService.createTextOutput(JSON.stringify(saveRewardRecord(params)))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (params.action === 'deleteReward') {
    return ContentService.createTextOutput(JSON.stringify(deleteRewardRecord(params)))
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
      const requesterUid = String(payload.uid || '').trim();
      const statusInfo = getRegistrationSystemStatus();
      return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        ...statusInfo,
        isAdmin: requesterUid === ADMIN_UID,
        serverTime: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // กรณีแอดมินตั้งวันเวลาเปิด-ปิดระบบผ่าน POST: action = setSchedule, setClosingDateTime หรือ toggleSystemStatus
    if (payload.action === 'setSchedule' || payload.action === 'setClosingDateTime' || payload.action === 'toggleSystemStatus') {
      const adminUid = String(payload.adminUid || payload.uid || '').trim();
      const openingDateTime = payload.openingDateTime !== undefined ? payload.openingDateTime : null;
      const closingDateTime = payload.closingDateTime !== undefined ? payload.closingDateTime : null;
      const manualStatus = payload.targetStatus ? String(payload.targetStatus) : null;
      const res = setRegistrationSchedule(openingDateTime, closingDateTime, adminUid, manualStatus);
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
      return ContentService.createTextOutput(JSON.stringify(getRewardInitData()))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'checkRegisteredEmployee') {
      return ContentService.createTextOutput(JSON.stringify(checkRegisteredEmployeeById(payload.empId)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'getRewards') {
      return ContentService.createTextOutput(JSON.stringify(getRewardsList()))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'saveReward') {
      return ContentService.createTextOutput(JSON.stringify(saveRewardRecord(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (payload.action === 'deleteReward') {
      return ContentService.createTextOutput(JSON.stringify(deleteRewardRecord(payload)))
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
  const token = (typeof LINE_BOT_ACCESS_TOKEN !== 'undefined' && LINE_BOT_ACCESS_TOKEN)
    ? LINE_BOT_ACCESS_TOKEN
    : 'ZUF3tyAspwl3dVgo+5YSqfJZpu1fA438z3vIyHmga+Jre+ZuWrg30Xj1qV4ews6AG+RLY/FiaC+L6lkk6HoEHsed4ZYB7NMMS6n+rWxcpulnh3V7SAohcUx1+84NR8niEI41u5zLf3hlRm5jvKkWIAdB04t89/1O/w1cDnyilFU=';
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

  const lastCol = Math.max(8, regSheet.getLastColumn());
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
      pictureUrl: pic
    };
  }

  return { uidMap: uidMap, employeesMap: employeesMap };
}

/**
 * ค้นหาข้อมูลพนักงานเฉพาะผู้ที่ลงทะเบียนใน Sheet "Register" เท่านั้น
 */
function checkRegisteredEmployeeById(empId) {
  try {
    const searchId = String(empId || '').trim().replace(/\.0$/, '');
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
 * เพื่อให้หน้าเว็บค้นหารหัสพนักงานได้ทันทีแบบ 0ms (รวดเร็ว ไม่หน่วงเวลาคีย์)
 */
function getRewardInitData() {
  try {
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

function getRewardsList() {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const { uidMap } = getRegisteredEmployeesFromRegisterSheet(ss);
    const rewards = getRewardsListInternal(ss, uidMap);
    return { status: 'success', rewards: rewards };
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
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

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

    // ตรวจสอบว่ารหัสพนักงานนี้เคยได้รับรางวัลไปแล้วหรือไม่ (ป้องกันการรับรางวัลซ้ำ)
    if (empId) {
      const lastRow = rewardSheet.getLastRow();
      if (lastRow >= 2) {
        const existingRows = rewardSheet.getRange(2, 1, lastRow - 1, 2).getValues();
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
    lock.releaseLock();
  }
}

/**
 * ลบข้อมูลผู้รับรางวัล (ล้างค่าผู้รับรางวัลในคอลัมน์ B:F หรือลบทั้งแถว)
 */
function deleteRewardRecord(payload) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
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
    lock.releaseLock();
  }
}

/**
 * ส่ง LINE Push Message (Flex Message) แจ้งเตือนผู้โชคดีที่ได้รับรางวัล
 */
function pushRewardFlexMessage(uid, info) {
  const token = (typeof CHANNEL_ACCESS_TOKEN !== 'undefined' && CHANNEL_ACCESS_TOKEN)
    ? CHANNEL_ACCESS_TOKEN
    : 'ZUF3tyAspwl3dVgo+5YSqfJZpu1fA438z3vIyHmga+Jre+ZuWrg30Xj1qV4ews6AG+RLY/FiaC+L6lkk6HoEHsed4ZYB7NMMS6n+rWxcpulnh3V7SAohcUx1+84NR8niEI41u5zLf3hlRm5jvKkWIAdB04t89/1O/w1cDnyilFU=';

  const nowStr = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const flexMsg = {
    type: 'flex',
    altText: `🎉 ขอแสดงความยินดี! คุณได้รับรางวัล: ${info.rewardName}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#991B1B',
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
                backgroundColor: '#FBBF24',
                cornerRadius: '20px',
                paddingStart: '10px',
                paddingEnd: '10px',
                paddingTop: '4px',
                paddingBottom: '4px',
                flex: 0,
                contents: [
                  {
                    type: 'text',
                    text: 'LUCKY DRAW WINNER',
                    color: '#78350F',
                    size: 'xxs',
                    weight: 'bold'
                  }
                ]
              },
              {
                type: 'text',
                text: 'CM PARTY',
                color: '#FDE68A',
                size: 'xs',
                weight: 'bold',
                align: 'end'
              }
            ]
          },
          {
            type: 'text',
            text: 'ขอแสดงความยินดีด้วยครับ!',
            color: '#FFFFFF',
            size: 'xl',
            weight: 'bold',
            margin: 'md'
          },
          {
            type: 'text',
            text: 'คุณคือผู้โชคดีได้รับรางวัลในงานเลี้ยง',
            color: '#FECACA',
            size: 'xs',
            margin: 'xs'
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
            backgroundColor: '#FEFCE8',
            borderColor: '#F59E0B',
            borderWidth: '2px',
            cornerRadius: '14px',
            paddingAll: '16px',
            alignItems: 'center',
            spacing: 'xs',
            contents: [
              {
                type: 'text',
                text: 'รางวัลที่ได้รับ',
                color: '#B45309',
                size: 'xs',
                weight: 'bold'
              },
              {
                type: 'text',
                text: info.rewardName || '-',
                color: '#991B1B',
                size: 'lg',
                weight: 'bold',
                align: 'center',
                wrap: true
              }
            ]
          },
          {
            type: 'separator',
            margin: 'md',
            color: '#E5E7EB'
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            margin: 'md',
            contents: [
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  {
                    type: 'text',
                    text: 'รหัสพนักงาน',
                    color: '#6B7280',
                    size: 'xs',
                    flex: 4
                  },
                  {
                    type: 'text',
                    text: String(info.empId || '-'),
                    color: '#111827',
                    size: 'sm',
                    weight: 'bold',
                    flex: 6,
                    wrap: true
                  }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  {
                    type: 'text',
                    text: 'ชื่อ - สกุล',
                    color: '#6B7280',
                    size: 'xs',
                    flex: 4
                  },
                  {
                    type: 'text',
                    text: info.empName || '-',
                    color: '#111827',
                    size: 'sm',
                    weight: 'bold',
                    flex: 6,
                    wrap: true
                  }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  {
                    type: 'text',
                    text: 'แผนก',
                    color: '#6B7280',
                    size: 'xs',
                    flex: 4
                  },
                  {
                    type: 'text',
                    text: info.department || '-',
                    color: '#374151',
                    size: 'xs',
                    flex: 6,
                    wrap: true
                  }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  {
                    type: 'text',
                    text: 'สาขา',
                    color: '#6B7280',
                    size: 'xs',
                    flex: 4
                  },
                  {
                    type: 'text',
                    text: info.branch || '-',
                    color: '#15803D',
                    size: 'xs',
                    weight: 'bold',
                    flex: 6,
                    wrap: true
                  }
                ]
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
      }
    }
  };

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

      // 1.1) กรณีบล็อกหรือเลิกติดตาม (unfollow)
      else if (event.type === 'unfollow') {
        const unfollowUserId = event.source && event.source.userId;
        if (unfollowUserId) {
          try {
            CacheService.getScriptCache().remove('IS_FRIEND_' + unfollowUserId);
          } catch (e) {}
        }
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
 * - เมื่อพิมพ์ "ตรวจสอบรางวัล" -> บอทตอบกลับ "กรุณาพิมพ์รหัสพนักงานของท่าน" และบันทึกสถานะรอรหัสพนักงาน
 * - เมื่อพิมพ์รหัสพนักงานเข้ามา -> บอทค้นหารหัสพนักงานใน Sheet "gift" คอลัมน์ B2:B แล้วแจ้งผลการได้รับรางวัล
 */
function handleTextMessage(event) {
  const replyToken = event.replyToken;
  const userId = (event.source && (event.source.userId || event.source.groupId || event.source.roomId)) || 'anon';
  const rawText = String((event.message && event.message.text) || '').trim();
  const normalizedCommand = rawText.replace(/\s+/g, '');

  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  const stateKey = 'WAIT_REWARD_EMP_' + userId;

  // 1. หากผู้ใช้พิมพ์คำว่า "ตรวจสอบรางวัล" (หรือ "ตรวจสอบ รางวัล")
  if (normalizedCommand === 'ตรวจสอบรางวัล') {
    cache.put(stateKey, 'WAITING', 600); // จำสถานะรอรับรหัสพนักงานเป็นเวลา 10 นาที
    props.setProperty(stateKey, String(Date.now()));

    replyLineMessage(replyToken, [
      {
        type: 'text',
        text: 'กรุณาพิมพ์รหัสพนักงานของท่าน'
      }
    ]);
    return;
  }

  // 2. ตรวจสอบว่าผู้ใช้อยู่ในสถานะรอกรอกรหัสพนักงานหลังจากพิมพ์ "ตรวจสอบรางวัล" หรือไม่
  let isWaitingForEmpId = cache.get(stateKey) === 'WAITING';
  if (!isWaitingForEmpId) {
    const savedTime = props.getProperty(stateKey);
    if (savedTime && (Date.now() - Number(savedTime) < 15 * 60 * 1000)) {
      isWaitingForEmpId = true;
    }
  }

  // รองรับกรณีพิมพ์ "ตรวจสอบรางวัล 672002" ในบรรทัดเดียวกันด้วย
  let empIdToSearch = '';
  if (rawText.indexOf('ตรวจสอบรางวัล') === 0 && normalizedCommand !== 'ตรวจสอบรางวัล') {
    empIdToSearch = rawText.replace(/^ตรวจสอบ\s*รางวัล\s*/i, '').trim();
  } else if (isWaitingForEmpId) {
    empIdToSearch = rawText;
  }

  if (!empIdToSearch) {
    return;
  }

  // ล้างสถานะรอรหัสพนักงานเมื่อรับค่ามาตรวจสอบแล้ว
  cache.remove(stateKey);
  props.deleteProperty(stateKey);

  if (event.source && event.source.userId) {
    startLoadingAnimation(event.source.userId, 5);
  }

  // ค้นหาข้อมูลจาก Sheet "gift" โดยตรวจสอบรหัสพนักงานในคอลัมน์ B2:B
  const checkResult = checkGiftRewardByEmpId(empIdToSearch);

  if (checkResult.found && checkResult.rewards.length > 0) {
    const rewardFlex = createGiftCheckFlexMessage(empIdToSearch, checkResult.rewards);
    replyLineMessage(replyToken, [rewardFlex]);
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
    replyLineMessage(replyToken, [noRewardFlex]);
  }
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
    backgroundColor: '#FEFCE8',
    borderColor: '#F59E0B',
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
        color: '#B45309',
        size: 'xs',
        weight: 'bold'
      },
      {
        type: 'text',
        text: item.rewardName || '-',
        color: '#991B1B',
        size: 'lg',
        weight: 'bold',
        align: 'center',
        wrap: true
      }
    ]
  }));

  return {
    type: 'flex',
    altText: `🎉 ผลการตรวจสอบรางวัล รหัส ${first.empId}: ได้รับ ${allPrizeNames}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#991B1B',
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
                backgroundColor: '#FBBF24',
                cornerRadius: '20px',
                paddingStart: '10px',
                paddingEnd: '10px',
                paddingTop: '4px',
                paddingBottom: '4px',
                flex: 0,
                contents: [
                  {
                    type: 'text',
                    text: 'REWARD CHECK',
                    color: '#78350F',
                    size: 'xxs',
                    weight: 'bold'
                  }
                ]
              },
              {
                type: 'text',
                text: 'CM PARTY',
                color: '#FDE68A',
                size: 'xs',
                weight: 'bold',
                align: 'end'
              }
            ]
          },
          {
            type: 'text',
            text: '🎉 ยินดีด้วย! คุณได้รับรางวัล',
            color: '#FFFFFF',
            size: 'xl',
            weight: 'bold',
            margin: 'md'
          },
          {
            type: 'text',
            text: 'ข้อมูลจากระบบตรวจสอบรางวัล (Sheet gift)',
            color: '#FECACA',
            size: 'xs',
            margin: 'xs'
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
          ...prizeBoxes,
          {
            type: 'separator',
            margin: 'md',
            color: '#E5E7EB'
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            margin: 'md',
            contents: [
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  {
                    type: 'text',
                    text: 'รหัสพนักงาน',
                    color: '#6B7280',
                    size: 'xs',
                    flex: 4
                  },
                  {
                    type: 'text',
                    text: String(first.empId || empId),
                    color: '#111827',
                    size: 'sm',
                    weight: 'bold',
                    flex: 6,
                    wrap: true
                  }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  {
                    type: 'text',
                    text: 'ชื่อ - สกุล',
                    color: '#6B7280',
                    size: 'xs',
                    flex: 4
                  },
                  {
                    type: 'text',
                    text: first.empName || '-',
                    color: '#111827',
                    size: 'sm',
                    weight: 'bold',
                    flex: 6,
                    wrap: true
                  }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  {
                    type: 'text',
                    text: 'แผนก',
                    color: '#6B7280',
                    size: 'xs',
                    flex: 4
                  },
                  {
                    type: 'text',
                    text: first.department || '-',
                    color: '#374151',
                    size: 'xs',
                    flex: 6,
                    wrap: true
                  }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                contents: [
                  {
                    type: 'text',
                    text: 'สาขา',
                    color: '#6B7280',
                    size: 'xs',
                    flex: 4
                  },
                  {
                    type: 'text',
                    text: first.branch || '-',
                    color: '#15803D',
                    size: 'xs',
                    weight: 'bold',
                    flex: 6,
                    wrap: true
                  }
                ]
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
            action: {
              type: 'message',
              label: 'ตรวจสอบรางวัล',
              text: 'ตรวจสอบรางวัล'
            }
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
      }
    }
  };
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
    {
      type: 'box',
      layout: 'baseline',
      contents: [
        {
          type: 'text',
          text: 'รหัสพนักงาน',
          color: '#6B7280',
          size: 'xs',
          flex: 4
        },
        {
          type: 'text',
          text: String(empId || '-'),
          color: '#111827',
          size: 'sm',
          weight: 'bold',
          flex: 6,
          wrap: true
        }
      ]
    }
  ];

  if (empName) {
    employeeDetailRows.push({
      type: 'box',
      layout: 'baseline',
      contents: [
        {
          type: 'text',
          text: 'ชื่อ - สกุล',
          color: '#6B7280',
          size: 'xs',
          flex: 4
        },
        {
          type: 'text',
          text: empName,
          color: '#111827',
          size: 'sm',
          weight: 'bold',
          flex: 6,
          wrap: true
        }
      ]
    });
  }

  if (department) {
    employeeDetailRows.push({
      type: 'box',
      layout: 'baseline',
      contents: [
        {
          type: 'text',
          text: 'แผนก',
          color: '#6B7280',
          size: 'xs',
          flex: 4
        },
        {
          type: 'text',
          text: department,
          color: '#374151',
          size: 'xs',
          flex: 6,
          wrap: true
        }
      ]
    });
  }

  if (branch) {
    employeeDetailRows.push({
      type: 'box',
      layout: 'baseline',
      contents: [
        {
          type: 'text',
          text: 'สาขา',
          color: '#6B7280',
          size: 'xs',
          flex: 4
        },
        {
          type: 'text',
          text: branch,
          color: '#15803D',
          size: 'xs',
          weight: 'bold',
          flex: 6,
          wrap: true
        }
      ]
    });
  }

  return {
    type: 'flex',
    altText: `ผลการตรวจสอบรางวัล รหัส ${empId}: ท่านไม่ได้รางวัลค่ะ`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#991B1B',
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
                backgroundColor: '#F3F4F6',
                cornerRadius: '20px',
                paddingStart: '10px',
                paddingEnd: '10px',
                paddingTop: '4px',
                paddingBottom: '4px',
                flex: 0,
                contents: [
                  {
                    type: 'text',
                    text: 'REWARD CHECK',
                    color: '#374151',
                    size: 'xxs',
                    weight: 'bold'
                  }
                ]
              },
              {
                type: 'text',
                text: 'CM PARTY',
                color: '#FDE68A',
                size: 'xs',
                weight: 'bold',
                align: 'end'
              }
            ]
          },
          {
            type: 'text',
            text: 'ท่านไม่ได้รางวัลค่ะ',
            color: '#FFFFFF',
            size: 'xl',
            weight: 'bold',
            margin: 'md'
          },
          {
            type: 'text',
            text: 'ระบบตรวจสอบรางวัล CM Party',
            color: '#FECACA',
            size: 'xs',
            margin: 'xs'
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
            backgroundColor: '#FEF2F2',
            borderColor: '#FCA5A5',
            borderWidth: '1.5px',
            cornerRadius: '14px',
            paddingAll: '16px',
            alignItems: 'center',
            spacing: 'xs',
            contents: [
              {
                type: 'text',
                text: '🎁 สถานะการรับรางวัล',
                color: '#991B1B',
                size: 'xs',
                weight: 'bold'
              },
              {
                type: 'text',
                text: 'ท่านไม่ได้รางวัลค่ะ',
                color: '#DC2626',
                size: 'lg',
                weight: 'bold',
                align: 'center',
                margin: 'xs'
              },
              {
                type: 'text',
                text: 'ขอขอบคุณที่ร่วมสนุกกับงานเลี้ยง CM Party ลุ้นใหม่ในรอบถัดไปนะคะ',
                color: '#6B7280',
                size: 'xs',
                align: 'center',
                wrap: true,
                margin: 'sm'
              }
            ]
          },
          {
            type: 'separator',
            margin: 'md',
            color: '#E5E7EB'
          },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            margin: 'md',
            contents: employeeDetailRows
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
            color: '#DC2626',
            height: 'sm',
            action: {
              type: 'message',
              label: 'ตรวจสอบรางวัล',
              text: 'ตรวจสอบรางวัล'
            }
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
      }
    }
  };
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

    replyLineMessage(replyToken, [
      {
        type: 'text',
        text: 'อัพโหลดรูปสำเร็จ'
      }
    ]);
  } catch (err) {
    console.error('Error handling image:', err);
    replyLineMessage(replyToken, [
      {
        type: 'text',
        text: '❌ เกิดข้อผิดพลาดในการอัปโหลดรูปภาพ: ' + err.message
      }
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
      'Authorization': 'Bearer ' + LINE_BOT_ACCESS_TOKEN
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
      'Authorization': 'Bearer ' + LINE_BOT_ACCESS_TOKEN
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
      'Authorization': 'Bearer ' + LINE_BOT_ACCESS_TOKEN
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
    altText: 'กรุณากดเพิ่มเพื่อนก่อนเข้าใช้งานแชท CM Party',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#DC2626',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: '⚠️ ต้องเพิ่มเพื่อนก่อนใช้งานแชท',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'md'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: 'คุณยังไม่ได้กดเพิ่มเพื่อนกับเรา',
            weight: 'bold',
            size: 'sm',
            color: '#1F2937'
          },
          {
            type: 'text',
            text: 'กรุณากดปุ่ม "เพิ่มเพื่อน" (Add Friend) ที่ด้านบนของห้องแชท หรือกดปุ่มด้านล่าง เพื่อเริ่มใช้งานระบบลงทะเบียน ตรวจสอบรางวัล และอัปโหลดภาพกิจกรรมครับ',
            wrap: true,
            size: 'xs',
            color: '#4B5563'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#06C755',
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

  replyLineMessage(replyToken, [flexMessage]);
}

function getLineMessageContent(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const options = {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + LINE_BOT_ACCESS_TOKEN
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
      'Authorization': 'Bearer ' + LINE_BOT_ACCESS_TOKEN
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
    : 'https://cdn-icons-png.flaticon.com/512/149/149071.png';
  const statusMessage = profile.statusMessage || 'ยินดีต้อนรับเข้าสู่ระบบอัปโหลดรูปภาพ!';
  const userId = profile.userId || '-';

  return {
    type: 'flex',
    altText: `ยินดีต้อนรับคุณ ${displayName}!`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#06C755',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: '🎉 WELCOME NEW FRIEND',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'sm',
            align: 'center'
          },
          {
            type: 'text',
            text: 'ยินดีต้อนรับเพื่อนใหม่!',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'xl',
            align: 'center',
            margin: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '24px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            alignItems: 'center',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                width: '100px',
                height: '100px',
                cornerRadius: '50px',
                borderWidth: '3px',
                borderColor: '#06C755',
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
                size: 'xl',
                color: '#111111',
                margin: 'md',
                align: 'center',
                wrap: true
              },
              {
                type: 'text',
                text: statusMessage,
                size: 'sm',
                color: '#666666',
                margin: 'xs',
                align: 'center',
                wrap: true
              }
            ]
          },
          {
            type: 'separator',
            margin: 'lg'
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'lg',
            spacing: 'sm',
            backgroundColor: '#F7F9FA',
            cornerRadius: '8px',
            paddingAll: '12px',
            contents: [
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: 'User ID:',
                    color: '#888888',
                    size: 'xs',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: userId,
                    color: '#333333',
                    size: 'xs',
                    flex: 5,
                    wrap: true
                  }
                ]
              },
              {
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                contents: [
                  {
                    type: 'text',
                    text: 'วิธีใช้งาน:',
                    color: '#888888',
                    size: 'xs',
                    flex: 2
                  },
                  {
                    type: 'text',
                    text: 'ส่งรูปภาพมาที่แชทนี้เพื่ออัปโหลดขึ้น Drive หรือพิมพ์ "ตรวจสอบรางวัล" เพื่อเช็คผลรางวัล!',
                    color: '#06C755',
                    weight: 'bold',
                    size: 'xs',
                    flex: 5,
                    wrap: true
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  };
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
