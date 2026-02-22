// cloudfunctions/joinRoom/index.js
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function isDuplicateKeyError(err) {
  const msg = String((err && (err.errMsg || err.message)) || err || '');
  return msg.includes('duplicate') || msg.includes('E11000') || msg.includes('already exists');
}

function safeNickname(nickname, openid) {
  const value = typeof nickname === 'string' ? nickname.trim() : '';
  if (value) return value.slice(0, 30);
  return '酒友' + String(openid).slice(-4);
}

function normalizeAvatar(avatar) {
  return typeof avatar === 'string' ? avatar.trim() : '';
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext() || {};
  const openid = wxContext.OPENID || event.openid;

  const roomId = String(event.roomId || '').trim();
  const nickname = safeNickname(event.nickname, openid);
  const avatar = normalizeAvatar(event.avatar);
  const unit = typeof event.unit === 'string' && event.unit.trim() ? event.unit.trim() : '杯';

  if (!roomId) return { ok: false, message: 'roomId required' };
  if (!openid) return { ok: false, message: 'openid unavailable' };

  const roomRef = db.collection('rooms').doc(roomId);
  const userItem = {
    openid,
    nickname,
    avatar,
    createdAt: db.serverDate(),
  };

  // 1) 尝试读房间
  try {
    const roomRes = await roomRef.get();
    const room = roomRes.data || {};
    const users = Array.isArray(room.users) ? room.users : [];

    const exists = users.some(u => u && u.openid === openid);

    if (!exists) {
      await roomRef.update({
        data: {
          users: _.push(userItem)
        }
      });
    } else {
      // 已在房间时，同步昵称和头像，避免一直显示旧资料
      let changed = false;
      const nextUsers = users.map(u => {
        if (!u || u.openid !== openid) return u;

        const nextNick = nickname || u.nickname;
        const nextAvatar = avatar || normalizeAvatar(u.avatar);
        if (u.nickname !== nextNick || normalizeAvatar(u.avatar) !== nextAvatar) {
          changed = true;
          return { ...u, nickname: nextNick, avatar: nextAvatar };
        }
        return u;
      });

      if (changed) {
        await roomRef.update({
          data: { users: nextUsers }
        });
      }
    }

    // 如果房间没 unit，补一下
    if (!room.unit) {
      await roomRef.update({ data: { unit } });
    }

    return { ok: true, openid };
  } catch (e) {
    // 2) 房间不存在，创建
    try {
      await db.collection('rooms').add({
        data: {
          _id: roomId,
          unit,
          users: [userItem],
          createdAt: db.serverDate(),
        }
      });
      return { ok: true, openid, created: true };
    } catch (createErr) {
      if (!isDuplicateKeyError(createErr)) throw createErr;

      // 并发场景下，可能 get 与 add 之间被其它请求创建，回退到 update
      const roomRes = await roomRef.get();
      const room = roomRes.data || {};
      const users = Array.isArray(room.users) ? room.users : [];
      const exists = users.some(u => u && u.openid === openid);
      const updateData = {};

      if (!exists) {
        updateData.users = _.push(userItem);
      } else {
        const nextUsers = users.map(u => {
          if (!u || u.openid !== openid) return u;
          return {
            ...u,
            nickname: nickname || u.nickname,
            avatar: avatar || normalizeAvatar(u.avatar),
          };
        });
        updateData.users = nextUsers;
      }
      if (!room.unit) updateData.unit = unit;
      if (Object.keys(updateData).length > 0) {
        await roomRef.update({ data: updateData });
      }

      return { ok: true, openid, merged: true };
    }
  }
};
