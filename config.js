// ==========================================
// ศูนย์กลางการตั้งค่าเว็บแอป CM Party 2026
// (ใช้ร่วมกันระหว่าง index.html, reward.html, gallery.html และ stage.html)
// หมายเหตุ: ครอบด้วย typeof window !== 'undefined' เพื่อไม่ให้ Error เมื่อถูก Push เข้า Google Apps Script
// ==========================================
if (typeof window !== 'undefined') {
  window.CM_PARTY_CONFIG = Object.freeze({
    LIFF_ID: '2012486224-eFJTgFwr',
    GAS_WEB_APP_URL: 'https://script.google.com/macros/s/AKfycbx6yDgQvf3RvCVu8nHRN3yQM6IM5Be2JZpESNT6nJ3XddDsOlrMj_S7nIPCRUqmZBjFYw/exec',
    BACKUP_GAS_WEB_APP_URL: '',
    SPREADSHEET_ID: '1j2wb2cBiPK2IDfpNKJZBSUu3MDVwSEogAkRENvU-GJw',
    REWARD_SHEET_GID: '195154721',
    REGISTER_LIFF_URL: 'https://liff.line.me/2012486224-eFJTgFwr'
  });
}
