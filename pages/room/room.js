// pages/room/room.js
let db = null;

Page({
  data: {
    roomId: '',
    entryRoomId: '',

    myOpenId: '',
    currentUnit: '杯',

    authRequired: true,

    // profile
    hasProfile: false,
    myProfile: { nickname: '我', avatar: '' },

    // room users -> computed players
    rawUsers: [],
    rawTx: [],
    players: [],

    // 顶部：欠（我欠别人的）
    myOweTotal: 0,

    // 明细
    showDetailModal: false,
    myOweList: [],
    oweMeList: [],

    // 输入弹窗
    showInputModal: false,
    inputMode: 'debt', // 'debt' | 'repay'
    selectedTarget: { openid: '', nickname: '', avatar: '' },
    inputAmount: 1,

    // 债主端：审批弹窗
    showApproveModal: false,
    pendingRepayTx: null,

    // 本机去重：避免同一条pending重复弹
    seenPendingIds: {},
  },

  // ---------------- lifecycle ----------------
  onLoad(options = {}) {
    if (!wx.cloud || typeof wx.cloud.database !== 'function') {
      wx.showToast({ title: '云能力不可用', icon: 'none' });
      return;
    }

    db = wx.cloud.database();
    this._watchers = { room: null, tx: null };
    this._txRefreshRunning = false;
    this._txRefreshPending = false;

    const entryRoomId = this._extractRoomIdFromOptions(options);
    if (entryRoomId) this.setData({ entryRoomId });

    this.getOpenIdAndJoin();
  },

  onUnload() {
    this._closeWatchers();
  },

  onShareAppMessage() {
    const roomId = this.data.roomId || this._loadCurrentRoomId();
    const safeRoomId = encodeURIComponent(roomId || '');
    return {
      title: '来一起记酒局账本',
      path: `/pages/room/room?roomId=${safeRoomId}`,
    };
  },

  // ---------------- base helpers ----------------
  _normalizeRoomId(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    return v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  },

  _extractRoomIdFromOptions(options = {}) {
    const direct = this._normalizeRoomId(options.roomId);
    if (direct) return direct;

    if (!options.scene) return '';
    const decoded = decodeURIComponent(options.scene);
    const match = decoded.match(/(?:^|&)roomId=([^&]+)/);
    if (match && match[1]) return this._normalizeRoomId(match[1]);
    return this._normalizeRoomId(decoded);
  },

  _createRoomId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `room_${ts}${rand}`;
  },

  _currentRoomKey() {
    return `WineDebt_currentRoom_${this.data.myOpenId || 'unknown'}`;
  },

  _loadCurrentRoomId() {
    if (!this.data.myOpenId) return '';
    return this._normalizeRoomId(wx.getStorageSync(this._currentRoomKey()));
  },

  _saveCurrentRoomId(roomId) {
    const id = this._normalizeRoomId(roomId);
    if (!id || !this.data.myOpenId) return;
    wx.setStorageSync(this._currentRoomKey(), id);
  },

  _profileKey() {
    return `WineDebt_profile_${this.data.myOpenId || 'unknown'}`;
  },

  _seenKey() {
    return `WineDebt_seenPending_${this.data.roomId || 'default'}`;
  },

  _closeWatchers() {
    try { this._watchers?.room?.close?.(); } catch (e) {}
    try { this._watchers?.tx?.close?.(); } catch (e) {}
    this._watchers = { room: null, tx: null };
  },

  _toMillis(timeValue) {
    if (!timeValue) return 0;
    if (typeof timeValue === 'number') return timeValue;
    if (timeValue instanceof Date) return timeValue.getTime();

    const hasCloudTimestamp = typeof timeValue === 'object' && (timeValue.seconds || timeValue.nanoseconds);
    if (hasCloudTimestamp) {
      return (Number(timeValue.seconds) || 0) * 1000 + Math.floor((Number(timeValue.nanoseconds) || 0) / 1000000);
    }

    const parsed = Date.parse(timeValue);
    return Number.isNaN(parsed) ? 0 : parsed;
  },

  _isGenericNickname(name) {
    const n = String(name || '').trim();
    return !n || n === '微信用户' || n === '用户';
  },

  _syncMyProfileFromRoom(users) {
    const meInRoom = (users || []).find(u => u && u.openid === this.data.myOpenId);
    if (!meInRoom) return;

    const localProfile = this.data.myProfile || { nickname: '我', avatar: '' };
    const localNick = localProfile.nickname || '我';
    const localAvatar = localProfile.avatar || '';
    const roomNick = typeof meInRoom.nickname === 'string' ? meInRoom.nickname.trim() : '';
    const roomAvatar = typeof meInRoom.avatar === 'string' ? meInRoom.avatar.trim() : '';
    const genericNick = !roomNick || roomNick === '我' || roomNick === '测试我' || roomNick === '房主' || roomNick.startsWith('酒友');

    const nextProfile = {
      nickname: (this.data.hasProfile && localNick && genericNick) ? localNick : (roomNick || localNick || '我'),
      avatar: roomAvatar || localAvatar || '',
    };

    const hasProfile = !!nextProfile.avatar || (nextProfile.nickname && nextProfile.nickname !== '我' && !nextProfile.nickname.startsWith('酒友'));
    this.setData({
      myProfile: nextProfile,
      hasProfile: this.data.hasProfile || hasProfile,
    });
  },

  _resolveRoomIdForStart() {
    const entryRoomId = this._normalizeRoomId(this.data.entryRoomId);
    if (entryRoomId) return entryRoomId;

    const stored = this._loadCurrentRoomId();
    if (stored) return stored;

    return this._createRoomId();
  },

  _resetPageStateForRoom(roomId, resetSeen = false) {
    this.setData({
      roomId,
      currentUnit: '杯',
      rawUsers: [],
      rawTx: [],
      players: [],
      myOweTotal: 0,
      myOweList: [],
      oweMeList: [],
      showDetailModal: false,
      showInputModal: false,
      showApproveModal: false,
      pendingRepayTx: null,
      selectedTarget: { openid: '', nickname: '', avatar: '' },
      inputAmount: 1,
    });

    if (resetSeen) wx.setStorageSync(this._seenKey(), {});
    const seen = wx.getStorageSync(this._seenKey()) || {};
    this.setData({ seenPendingIds: seen });
  },

  async _enterRoom(roomId, resetSeen = false) {
    const normalizedRoomId = this._normalizeRoomId(roomId);
    if (!normalizedRoomId || !this.data.myOpenId) return;

    this._closeWatchers();
    this._resetPageStateForRoom(normalizedRoomId, resetSeen);
    this._saveCurrentRoomId(normalizedRoomId);

    await this.joinRoomViaCloud(this.data.myOpenId);
    if (this.data.hasProfile && this.data.myProfile?.nickname) {
      try {
        await this.updateMyProfileInRoom(this.data.myProfile.nickname, this.data.myProfile.avatar || '');
      } catch (e) {
        console.error('sync profile after join fail', e);
      }
    }
    this.startWatchers();
    await this.refreshData(false);

    // 邀请链接只在启动阶段消费一次
    if (this.data.entryRoomId) this.setData({ entryRoomId: '' });
  },

  // ---------------- auth / boot ----------------
  async getOpenIdAndJoin() {
    let openid = '';
    try {
      const res = await wx.cloud.callFunction({ name: 'login' });
      openid = res?.result?.openid || '';
      if (!openid) throw new Error('openid empty');
    } catch (err) {
      console.error('login 云函数失败', err);
      const testKey = 'WineDebt_testOpenId';
      openid = wx.getStorageSync(testKey);
      if (!openid) {
        openid = 'test_' + Date.now();
        wx.setStorageSync(testKey, openid);
      }
      wx.showToast({ title: '测试模式', icon: 'none' });
    }

    this.setData({ myOpenId: openid });

    const localProfile = wx.getStorageSync(this._profileKey());
    if (localProfile && localProfile.nickname) {
      this.setData({
        hasProfile: true,
        authRequired: false,
        myProfile: {
          nickname: localProfile.nickname || '我',
          avatar: localProfile.avatar || '',
        },
      });

      const roomId = this._resolveRoomIdForStart();
      await this._enterRoom(roomId, false);
      return;
    }

    this.setData({
      authRequired: true,
      hasProfile: false,
      myProfile: { nickname: '我', avatar: '' },
    });
  },

  async onGetProfileTap() {
    try {
      const res = typeof wx.getUserProfile === 'function'
        ? await wx.getUserProfile({ desc: '用于显示头像昵称' })
        : await wx.getUserInfo();

      const nickname = res.userInfo?.nickName || '我';
      const avatar = res.userInfo?.avatarUrl || '';

      if (this._isGenericNickname(nickname) || !avatar) {
        wx.showToast({ title: '请在开始页设置昵称和头像', icon: 'none' });
        wx.reLaunch({ url: '/pages/index/index' });
        return;
      }

      this.setData({
        authRequired: false,
        hasProfile: true,
        myProfile: { nickname, avatar },
      });

      wx.setStorageSync(this._profileKey(), { nickname, avatar });

      const storedRoomId = this._loadCurrentRoomId();
      const roomId = this.data.entryRoomId || storedRoomId || this._createRoomId();
      const resetSeen = !this.data.entryRoomId && !storedRoomId;

      await this._enterRoom(roomId, resetSeen);
      await this.updateMyProfileInRoom(nickname, avatar);
      await this.refreshData(false);

      wx.showToast({ title: '已授权', icon: 'success' });
    } catch (e) {
      console.error('getUserProfile fail', e);
      this.setData({ authRequired: true, hasProfile: false });
      wx.showToast({ title: '未授权无法使用', icon: 'none' });
    }
  },

  // ---------------- cloud join ----------------
  async joinRoomViaCloud(openid, isTest = false) {
    const nickname = this.data.myProfile?.nickname || (isTest ? '测试我' : ('酒友' + openid.slice(-4)));
    const avatar = this.data.myProfile?.avatar || '';

    try {
      await wx.cloud.callFunction({
        name: 'joinRoom',
        data: { roomId: this.data.roomId, nickname, avatar, unit: this.data.currentUnit }
      });
    } catch (e) {
      console.error('joinRoom 云函数失败（可能没部署/权限问题）', e);
      await this.joinRoomLocalFallback(openid, nickname, avatar);
    }
  },

  async joinRoomLocalFallback(openid, nickname, avatar) {
    const _ = db.command;
    const roomRef = db.collection('rooms').doc(this.data.roomId);

    try {
      const roomRes = await roomRef.get();
      const room = roomRes.data || {};
      const users = Array.isArray(room.users) ? room.users : [];
      const exists = users.some(u => u && u.openid === openid);

      if (!exists) {
        await roomRef.update({
          data: {
            users: _.push({ openid, nickname, avatar, createdAt: db.serverDate() })
          }
        });
      }
      if (!room.unit) await roomRef.update({ data: { unit: this.data.currentUnit || '杯' } });
    } catch (e) {
      await db.collection('rooms').add({
        data: {
          _id: this.data.roomId,
          unit: this.data.currentUnit || '杯',
          users: [{ openid, nickname, avatar, createdAt: db.serverDate() }],
          createdAt: db.serverDate(),
        }
      });
    }
  },

  // ---------------- data refresh ----------------
  async _fetchRoomDoc() {
    if (!this.data.roomId) return null;
    try {
      const res = await db.collection('rooms').doc(this.data.roomId).get();
      return res.data || null;
    } catch (e) {
      console.error('fetch room fail', e);
      return null;
    }
  },

  async _fetchAllTransactions(roomId = this.data.roomId) {
    if (!roomId) return [];

    const pageSize = 100;
    let skip = 0;
    const all = [];

    while (true) {
      const res = await db.collection('transactions')
        .where({ roomId })
        .skip(skip)
        .limit(pageSize)
        .get();

      const rows = Array.isArray(res.data) ? res.data : [];
      if (rows.length === 0) break;

      all.push(...rows);
      skip += rows.length;

      if (rows.length < pageSize) break;
      if (skip > 5000) break;
    }

    return all;
  },

  async _refreshTransactionsOnly() {
    if (this._txRefreshRunning) {
      this._txRefreshPending = true;
      return;
    }

    this._txRefreshRunning = true;
    try {
      const tx = await this._fetchAllTransactions();
      this.setData({ rawTx: tx });
      this.recomputeAll();
      this.maybePopupRepayApprove(tx);
    } catch (e) {
      console.error('refresh transactions fail', e);
    } finally {
      this._txRefreshRunning = false;
      if (this._txRefreshPending) {
        this._txRefreshPending = false;
        this._refreshTransactionsOnly();
      }
    }
  },

  async refreshData(showFeedback = false) {
    if (!db || !this.data.roomId) return;
    if (showFeedback) wx.showLoading({ title: '刷新中' });

    try {
      const [room, tx] = await Promise.all([
        this._fetchRoomDoc(),
        this._fetchAllTransactions(),
      ]);

      const updateData = { rawTx: tx };
      if (room) {
        updateData.currentUnit = room.unit || this.data.currentUnit;
        updateData.rawUsers = Array.isArray(room.users) ? room.users : [];
      }

      this.setData(updateData);
      this._syncMyProfileFromRoom(updateData.rawUsers || this.data.rawUsers || []);
      this.recomputeAll();
      this.maybePopupRepayApprove(tx);

      if (showFeedback) wx.showToast({ title: '已刷新', icon: 'none' });
    } catch (e) {
      console.error('refreshData fail', e);
      if (showFeedback) wx.showToast({ title: '刷新失败', icon: 'none' });
    } finally {
      if (showFeedback) wx.hideLoading();
    }
  },

  _getNetDebtBetween(debtorId, creditorId) {
    if (!debtorId || !creditorId) return 0;
    const tx = this.data.rawTx || [];
    let net = 0;

    tx.forEach(t => {
      if (!t || t.debtorId !== debtorId || t.creditorId !== creditorId) return;
      const kind = t.kind || 'debt';
      const status = t.status || 'final';
      const amount = Number(t.amount) || 0;
      if (amount <= 0) return;

      if (kind === 'debt' && status === 'final') net += amount;
      if (kind === 'repay' && status === 'approved') net -= amount;
    });

    return Math.max(0, Math.round(net));
  },

  // ---------------- watchers ----------------
  startWatchers() {
    this._closeWatchers();
    if (!this.data.roomId) return;

    this._watchers.room = db.collection('rooms')
      .doc(this.data.roomId)
      .watch({
        onChange: snap => {
          const doc = snap.docs && snap.docs[0];
          if (!doc) return;

          const unit = doc.unit || '杯';
          const users = Array.isArray(doc.users) ? doc.users : [];
          this.setData({ currentUnit: unit, rawUsers: users });
          this._syncMyProfileFromRoom(users);
          this.recomputeAll();
        },
        onError: err => console.error('rooms.watch error', err)
      });

    this._watchers.tx = db.collection('transactions')
      .where({ roomId: this.data.roomId })
      .watch({
        onChange: () => {
          this._refreshTransactionsOnly();
        },
        onError: err => console.error('tx.watch error', err)
      });
  },

  // ---------------- compute ----------------
  recomputeAll() {
    const users = this.data.rawUsers || [];
    const tx = this.data.rawTx || [];
    const me = this.data.myOpenId;

    const userMap = {};
    users.forEach(u => {
      if (!u || !u.openid) return;
      userMap[u.openid] = {
        openid: u.openid,
        nickname: u.nickname || ('酒友' + String(u.openid).slice(-4)),
        avatar: u.avatar || '',
      };
    });

    const pairNet = {};
    const totalDebt = {};

    const addPair = (debtorId, creditorId, delta) => {
      if (!debtorId || !creditorId) return;
      if (!pairNet[debtorId]) pairNet[debtorId] = {};
      if (!pairNet[debtorId][creditorId]) pairNet[debtorId][creditorId] = 0;
      pairNet[debtorId][creditorId] += delta;
    };

    tx.forEach(t => {
      const kind = t.kind || 'debt';
      const status = t.status || 'final';
      const debtorId = t.debtorId;
      const creditorId = t.creditorId;
      const amount = Number(t.amount) || 0;

      if (!debtorId || !creditorId || amount <= 0) return;

      if (kind === 'debt' && status === 'final') addPair(debtorId, creditorId, amount);
      if (kind === 'repay' && status === 'approved') addPair(debtorId, creditorId, -amount);
    });

    Object.keys(pairNet).forEach(debtorId => {
      let sum = 0;
      Object.keys(pairNet[debtorId]).forEach(creditorId => {
        sum += pairNet[debtorId][creditorId];
      });
      totalDebt[debtorId] = Math.max(0, Math.round(sum));
    });

    const players = users.map(u => {
      const id = u.openid;
      const base = userMap[id] || { openid: id, nickname: '酒友' + String(id).slice(-4), avatar: '' };
      const heOwesMe = Math.max(0, Math.round((pairNet[id]?.[me] || 0)));
      return {
        ...base,
        totalDebt: totalDebt[id] || 0,
        heOwesMe,
      };
    });

    let myOweTotal = 0;
    const myPairs = pairNet[me] || {};
    Object.keys(myPairs).forEach(creditorId => {
      myOweTotal += myPairs[creditorId];
    });
    myOweTotal = Math.max(0, Math.round(myOweTotal));

    const myOweList = [];
    Object.keys(myPairs).forEach(creditorId => {
      const amt = Math.max(0, Math.round(myPairs[creditorId] || 0));
      if (amt <= 0) return;
      const u = userMap[creditorId] || { nickname: '酒友' + String(creditorId).slice(-4) };
      myOweList.push({ openid: creditorId, name: u.nickname, amount: amt });
    });

    const oweMeList = [];
    users.forEach(u => {
      if (!u || !u.openid || u.openid === me) return;
      const amt = Math.max(0, Math.round(pairNet[u.openid]?.[me] || 0));
      if (amt <= 0) return;
      oweMeList.push({ openid: u.openid, name: (userMap[u.openid]?.nickname || u.nickname), amount: amt });
    });

    this.setData({
      players,
      myOweTotal,
      myOweList,
      oweMeList,
    });
  },

  // ---------------- repay approval popup ----------------
  maybePopupRepayApprove(allTx) {
    const me = this.data.myOpenId;
    if (!me) return;
    if (this.data.showApproveModal) return;

    const seen = this.data.seenPendingIds || {};
    const pending = allTx
      .filter(t => (t.kind === 'repay') && (t.status === 'pending') && t.creditorId === me)
      .sort((a, b) => {
        const t1 = this._toMillis(a.createdAt);
        const t2 = this._toMillis(b.createdAt);
        if (t1 !== t2) return t1 - t2;
        return String(a._id).localeCompare(String(b._id));
      });

    const next = pending.find(t => !seen[t._id]);
    if (!next) return;

    seen[next._id] = true;
    wx.setStorageSync(this._seenKey(), seen);
    this.setData({ seenPendingIds: seen });

    const users = this.data.rawUsers || [];
    const debtor = users.find(u => u && u.openid === next.debtorId);
    const debtorNickname = debtor?.nickname || ('酒友' + String(next.debtorId).slice(-4));

    this.setData({
      showApproveModal: true,
      pendingRepayTx: {
        _id: next._id,
        amount: next.amount,
        unit: next.unit || this.data.currentUnit,
        debtorId: next.debtorId,
        debtorNickname,
      }
    });
  },

  async approveRepay() {
    const tx = this.data.pendingRepayTx;
    if (!tx || !tx._id) return;

    try {
      await db.collection('transactions').doc(tx._id).update({
        data: { status: 'approved', approvedAt: db.serverDate() }
      });
      wx.showToast({ title: '已同意', icon: 'success' });
    } catch (e) {
      console.error('approveRepay fail', e);
      wx.showToast({ title: '失败', icon: 'none' });
    } finally {
      this.setData({ showApproveModal: false, pendingRepayTx: null });
    }
  },

  async rejectRepay() {
    const tx = this.data.pendingRepayTx;
    if (!tx || !tx._id) return;

    try {
      await db.collection('transactions').doc(tx._id).update({
        data: { status: 'rejected', rejectedAt: db.serverDate() }
      });
      wx.showToast({ title: '已拒绝', icon: 'none' });
    } catch (e) {
      console.error('rejectRepay fail', e);
      wx.showToast({ title: '失败', icon: 'none' });
    } finally {
      this.setData({ showApproveModal: false, pendingRepayTx: null });
    }
  },

  // ---------------- UI handlers ----------------
  noop() {},

  onMeCardTap() {},

  openDetailModal() {
    this.setData({ showDetailModal: true });
  },

  closeDetailModal() {
    this.setData({ showDetailModal: false });
  },

  async manualRefresh() {
    await this.refreshData(true);
  },

  changeUnit() {
    wx.showActionSheet({
      itemList: ['杯', '瓶', '口', 'Shot'],
      success: async res => {
        const units = ['杯', '瓶', '口', 'Shot'];
        const u = units[res.tapIndex] || '杯';
        this.setData({ currentUnit: u });
        try {
          if (this.data.roomId) {
            await db.collection('rooms').doc(this.data.roomId).update({ data: { unit: u } });
          }
        } catch (e) {
          console.error('update unit fail', e);
        }
      }
    });
  },

  async updateMyProfileInRoom(nickname, avatar) {
    if (!this.data.roomId || !this.data.myOpenId) return;
    const roomRef = db.collection('rooms').doc(this.data.roomId);
    try {
      const roomRes = await roomRef.get();
      const room = roomRes.data || {};
      const users = Array.isArray(room.users) ? room.users : [];
      const me = this.data.myOpenId;

      let exists = false;
      const newUsers = users.map(u => {
        if (!u || !u.openid) return u;
        if (u.openid !== me) return u;
        exists = true;
        return { ...u, nickname, avatar };
      });
      if (!exists) {
        newUsers.push({ openid: me, nickname, avatar, createdAt: db.serverDate() });
      }

      await roomRef.update({ data: { users: newUsers } });
    } catch (e) {
      console.error('updateMyProfileInRoom fail', e);
    }
  },

  onPlayerTap(e) {
    const target = e.currentTarget.dataset.target;
    if (!target || !target.openid) return;
    this.openInput('debt', target);
  },

  quickDebt(e) {
    const target = e.currentTarget.dataset.target;
    if (!target || !target.openid) return;
    this.openInput('debt', target);
  },

  quickRepay(e) {
    const target = e.currentTarget.dataset.target;
    if (!target || !target.openid) return;
    this.openInput('repay', target);
  },

  openInput(mode, target) {
    if (target.openid === this.data.myOpenId) {
      wx.showToast({ title: '不能对自己操作', icon: 'none' });
      return;
    }
    this.setData({
      inputMode: mode,
      selectedTarget: target,
      inputAmount: 1,
      showInputModal: true,
    });
  },

  onInputAmount(e) {
    const raw = Number(e.detail.value);
    const amount = Number.isFinite(raw) ? Math.floor(raw) : 0;
    this.setData({ inputAmount: Math.max(0, amount) });
  },

  closeModal() {
    this.setData({ showInputModal: false, inputAmount: 1 });
  },

  copyRoomCode() {
    const roomId = this.data.roomId;
    if (!roomId) {
      wx.showToast({ title: '房间码为空', icon: 'none' });
      return;
    }

    wx.setClipboardData({
      data: roomId,
      success: () => {
        wx.showToast({ title: '房间码已复制', icon: 'none' });
      },
      fail: (e) => {
        console.error('copy room code fail', e);
        wx.showToast({ title: '复制失败', icon: 'none' });
      }
    });
  },

  async _clearTransactionsFallback(roomId) {
    if (!roomId) return;
    const batchSize = 100;
    while (true) {
      const res = await db.collection('transactions')
        .where({ roomId })
        .limit(batchSize)
        .get();
      const rows = Array.isArray(res.data) ? res.data : [];
      if (rows.length === 0) break;

      for (const row of rows) {
        if (!row || !row._id) continue;
        await db.collection('transactions').doc(row._id).remove();
      }

      if (rows.length < batchSize) break;
    }
  },

  endCurrentGame() {
    if (!this.data.roomId || !this.data.myOpenId) return;

    wx.showModal({
      title: '结束当前游戏',
      content: '结束后会清空当前局记录，并返回主界面，确定吗？',
      confirmText: '结束并返回',
      cancelText: '取消',
      success: async ({ confirm }) => {
        if (!confirm) return;

        const oldRoomId = this.data.roomId;
        wx.showLoading({ title: '处理中' });

        try {
          try {
            await wx.cloud.callFunction({
              name: 'clearRoom',
              data: { roomId: oldRoomId },
            });
          } catch (e) {
            console.error('clearRoom 云函数失败，走本地兜底', e);
            await this._clearTransactionsFallback(oldRoomId);
          }

          try {
            await db.collection('rooms').doc(oldRoomId).update({
              data: {
                users: [],
                unit: '杯',
                endedAt: db.serverDate(),
              }
            });
          } catch (e) {
            console.error('reset old room fail', e);
          }

          wx.removeStorageSync(this._currentRoomKey());
          this._closeWatchers();
          wx.reLaunch({ url: '/pages/index/index?ended=1' });
        } catch (e) {
          console.error('endCurrentGame fail', e);
          wx.showToast({ title: '结束失败', icon: 'none' });
        } finally {
          wx.hideLoading();
        }
      }
    });
  },

  // ---------------- write transactions ----------------
  async confirmInput() {
    const amount = Number(this.data.inputAmount) || 0;
    if (amount <= 0) {
      wx.showToast({ title: '请输入大于0的数量', icon: 'none' });
      return;
    }

    const mode = this.data.inputMode;
    const me = this.data.myOpenId;
    const other = this.data.selectedTarget;

    if (!me) {
      wx.showToast({ title: '登录状态异常', icon: 'none' });
      return;
    }
    if (!other || !other.openid) {
      wx.showToast({ title: '目标用户无效', icon: 'none' });
      return;
    }
    if (other.openid === me) {
      wx.showToast({ title: '不能对自己操作', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '提交中' });

    try {
      if (mode === 'debt') {
        await db.collection('transactions').add({
          data: {
            roomId: this.data.roomId,
            kind: 'debt',
            status: 'final',
            debtorId: me,
            creditorId: other.openid,
            amount,
            unit: this.data.currentUnit,
            createdAt: db.serverDate(),
          }
        });
        wx.showToast({ title: '已欠酒', icon: 'success' });
      } else {
        const iOweOther = this._getNetDebtBetween(me, other.openid);
        const otherOwesMe = this._getNetDebtBetween(other.openid, me);

        if (otherOwesMe > 0) {
          const finalAmount = Math.min(amount, otherOwesMe);
          await db.collection('transactions').add({
            data: {
              roomId: this.data.roomId,
              kind: 'repay',
              status: 'approved',
              debtorId: other.openid,
              creditorId: me,
              amount: finalAmount,
              unit: this.data.currentUnit,
              confirmedBy: me,
              createdAt: db.serverDate(),
            }
          });
          wx.showToast({ title: '已记录还酒', icon: 'success' });
        } else if (iOweOther > 0) {
          const finalAmount = Math.min(amount, iOweOther);
          await db.collection('transactions').add({
            data: {
              roomId: this.data.roomId,
              kind: 'repay',
              status: 'pending',
              debtorId: me,
              creditorId: other.openid,
              amount: finalAmount,
              unit: this.data.currentUnit,
              debtorNickname: this.data.myProfile.nickname || '酒友',
              createdAt: db.serverDate(),
            }
          });
          wx.showToast({ title: '已申请还酒', icon: 'none' });
        } else {
          wx.showToast({ title: '当前无可还杯数', icon: 'none' });
          return;
        }
      }

      this.setData({ showInputModal: false });
    } catch (e) {
      console.error('confirmInput fail', e);
      wx.showToast({ title: '失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },
});
