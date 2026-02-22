// cloudfunctions/clearRoom/index.js
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const roomId = String((event && event.roomId) || '').trim();
  const batchSize = 100;
  
  // 安全检查：如果没有房间号，就不执行
  if (!roomId) return { success: false, msg: 'No roomId' };

  try {
    let removed = 0;
    while (true) {
      const snapshot = await db.collection('transactions')
        .where({ roomId })
        .limit(batchSize)
        .get();

      const rows = Array.isArray(snapshot.data) ? snapshot.data : [];
      if (rows.length === 0) break;

      for (const row of rows) {
        if (!row || !row._id) continue;
        await db.collection('transactions').doc(row._id).remove();
        removed += 1;
      }

      if (rows.length < batchSize) break;
    }

    return { success: true, removed };
  } catch (e) {
    console.error(e);
    return { success: false, error: e };
  }
};
