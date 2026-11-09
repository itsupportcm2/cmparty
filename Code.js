/**
 * CM Party - Google Apps Script Backend
 * รองรับ: ระบบลงทะเบียนร่วมงาน, สุ่มจับฉลากของขวัญ (Lucky Draw), และแสดงข้อมูลกิจกรรม
 */

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('CM Party 🎉 งานเลี้ยงสังสรรค์')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

/**
 * ดึงหรือสร้าง Spreadsheet สำหรับจัดเก็บข้อมูล
 */
function getOrCreateSheet(sheetName) {
  var ss;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  } catch (err) {
    ss = null;
  }
  
  // หากเป็น Standalone Script และยังไม่ได้ผูก Sheet สามารถสร้างหรือเชื่อมต่อได้
  if (!ss) {
    var props = PropertiesService.getScriptProperties();
    var sheetId = props.getProperty('SPREADSHEET_ID');
    if (sheetId) {
      try {
        ss = SpreadsheetApp.openById(sheetId);
      } catch (e) {
        ss = null;
      }
    }
    if (!ss) {
      ss = SpreadsheetApp.create('CM Party - Database');
      props.setProperty('SPREADSHEET_ID', ss.getId());
    }
  }

  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (sheetName === 'Registrations') {
      sheet.appendRow(['Timestamp', 'EmpId', 'Name', 'Department', 'Phone', 'Attendance', 'GiftStatus']);
      sheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#4f46e5').setFontColor('#ffffff');
    } else if (sheetName === 'Winners') {
      sheet.appendRow(['Timestamp', 'EmpId', 'Name', 'Department', 'Prize']);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#ec4899').setFontColor('#ffffff');
    }
  }
  return sheet;
}

/**
 * API: ลงทะเบียนร่วมงาน
 */
function apiRegister(formData) {
  try {
    var sheet = getOrCreateSheet('Registrations');
    var timestamp = new Date();
    
    // ตรวจสอบว่าเคยลงทะเบียนด้วยรหัสพนักงานนี้หรือยัง
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][1]).trim().toLowerCase() === String(formData.empId).trim().toLowerCase()) {
        return {
          success: false,
          message: 'รหัสพนักงาน ' + formData.empId + ' ได้ลงทะเบียนไปแล้ว'
        };
      }
    }

    sheet.appendRow([
      timestamp,
      formData.empId,
      formData.fullName,
      formData.department,
      formData.phone || '-',
      formData.attendance || 'เข้าร่วม',
      formData.hasGift ? 'มีของขวัญ' : 'ไม่มี'
    ]);

    return {
      success: true,
      message: 'ลงทะเบียนสำเร็จเรียบร้อยแล้ว!'
    };
  } catch (error) {
    return {
      success: false,
      message: 'เกิดข้อผิดพลาด: ' + error.toString()
    };
  }
}

/**
 * API: ดึงรายชื่อผู้มีสิทธิ์ลุ้นรางวัล (ผู้ที่เข้าร่วมงาน)
 */
function apiGetAttendees() {
  try {
    var sheet = getOrCreateSheet('Registrations');
    var data = sheet.getDataRange().getValues();
    var attendees = [];
    
    // ข้าม Header แถวแรก
    for (var i = 1; i < data.length; i++) {
      if (data[i][1] && data[i][2]) {
        attendees.push({
          empId: data[i][1],
          name: data[i][2],
          department: data[i][3],
          attendance: data[i][5]
        });
      }
    }
    return { success: true, data: attendees };
  } catch (error) {
    return { success: false, data: [], error: error.toString() };
  }
}

/**
 * API: บันทึกผู้ได้รับรางวัล
 */
function apiSaveWinner(winnerData) {
  try {
    var sheet = getOrCreateSheet('Winners');
    sheet.appendRow([
      new Date(),
      winnerData.empId,
      winnerData.name,
      winnerData.department,
      winnerData.prize
    ]);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

/**
 * API: ดึงรายชื่อผู้ได้รับรางวัลทั้งหมด
 */
function apiGetWinners() {
  try {
    var sheet = getOrCreateSheet('Winners');
    var data = sheet.getDataRange().getValues();
    var winners = [];
    
    for (var i = 1; i < data.length; i++) {
      if (data[i][1] && data[i][2]) {
        winners.push({
          timestamp: data[i][0],
          empId: data[i][1],
          name: data[i][2],
          department: data[i][3],
          prize: data[i][4]
        });
      }
    }
    return { success: true, data: winners };
  } catch (error) {
    return { success: false, data: [], error: error.toString() };
  }
}
