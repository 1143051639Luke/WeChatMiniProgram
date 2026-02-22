// pages/room/room.js
let db = null;

Page({
  data: {
    roomId: 'room_001',

    myOpenId: '',
    currentUnit: '杯',

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

    // 债主端：审批弹窗（不会一直弹）
    showApproveModal: false,
    pendingRepayTx: null,

    // 本机去重：避免同一条pending重复弹
    seenPendingIds: {},
  },

  // ---------------- lifecycle ----------------
  onLoad() {
    if (!wx.cloud || typeof wx.cloud.database !== 'function') {
      wx.showToast({ title: '云能力不可用', icon: 'none' });
      return;
    }

    db = wx.cloud.database();

    // 读本机缓存：seenPendingIds（防止反复弹）
    const cache = wx.getStorageSync(this._seenKey()) || {};
    this.setData({ seenPendingIds: cache });

    this._watchers = { room: null, tx: null };
    this.getOpenIdAndJoin();
  },

  onUnload() {
    this._closeWatchers();
  },

  _closeWatchers() {
    try { this._watchers?.room?.close?.(); } catch (e) {}
    try { this._watchers?.tx?.close?.(); } catch (e) {}
    this._watchers = { room: null, tx: null };
  },

  _seenKey() {
    return `WineDebt_seenPending_${this.data.roomId}`;
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

  // ---------------- auth / join ----------------
  async getOpenIdAndJoin() {
    try {
      const res = await wx.cloud.callFunction({ name: 'login' });
      const openid = res.result.openid;
      this.setData({ myOpenId: openid });

      // 先尝试用已授权profile加入
      const localProfile = wx.getStorageSync(this._profileKey());
      if (localProfile && localProfile.nickname) {
        this.setData({
          hasProfile: true,
          myProfile: localProfile,
        });
      }

      await this.joinRoomViaCloud(openid);

      this.startWatchers();
    } catch (err) {
      console.error('login 云函数失败', err);
      const testId = 'test_' + Date.now();
      this.setData({
        myOpenId: testId,
        myProfile: { nickname: '测试我', avatar: '' },
      });
      await this.joinRoomViaCloud(testId, true);
      this.startWatchers();
      wx.showToast({ title: '测试模式', icon: 'none' });
    }
  },

  _profileKey() {
    return `WineDebt_profile_${this.data.roomId}_${this.data.myOpenId || 'unknown'}`;
  },

  async joinRoomViaCloud(openid, isTest = false) {
    // 调 joinRoom 云函数：负责创建/加入 rooms
    const nickname = this.data.myProfile?.nickname || (isTest ? '测试我' : ('酒友' + openid.slice(-4)));
    const avatar = this.data.myProfile?.avatar || '';

    try {
      await wx.cloud.callFunction({
        name: 'joinRoom',
        data: { roomId: this.data.roomId, nickname, avatar, unit: this.data.currentUnit }
      });
    } catch (e) {
      console.error('joinRoom 云函数失败（可能没部署/权限问题）', e);
      // fallback：直接在客户端创建（仅用于你测试期权限全开时）
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
    } catch (e) {
      await db.collection('rooms').add({
        data: {
          _id: this.data.roomId,
          unit: '杯',
          users: [{ openid, nickname, avatar, createdAt: db.serverDate() }],
          createdAt: db.serverDate(),
        }
      });
    }
  },

  // ---------------- watchers ----------------
  startWatchers() {
    this._closeWatchers();

    // watch room
    this._watchers.room = db.collection('rooms')
      .doc(this.data.roomId)
      .watch({
        onChange: snap => {
          const doc = snap.docs && snap.docs[0];
          if (!doc) return;

          const unit = doc.unit || '杯';
          const users = Array.isArray(doc.users) ? doc.users : [];
          this.setData({ currentUnit: unit, rawUsers: users });

          // 同步我的 profile（如果 rooms 里有我的昵称头像）
          const me = users.find(u => u && u.openid === this.data.myOpenId);
          if (me && me.nickname) {
            this.setData({ myProfile: { nickname: me.nickname, avatar: me.avatar || '' } });
          }

          this.recomputeAll();
        },
        onError: err => console.error('rooms.watch error', err)
      });

    // watch transactions
    this._watchers.tx = db.collection('transactions')
      .where({ roomId: this.data.roomId })
      .watch({
        onChange: snap => {
          const tx = Array.isArray(snap.docs) ? snap.docs : [];
          this.setData({ rawTx: tx });
          this.recomputeAll();
          this.maybePopupRepayApprove(tx);
        },
        onError: err => console.error('tx.watch error', err)
      });
  },

  // ---------------- compute ----------------
  recomputeAll() {
    const users = this.data.rawUsers || [];
    const tx = this.data.rawTx || [];
    const me = this.data.myOpenId;

    // 构造用户映射
    const userMap = {};
    users.forEach(u => {
      if (!u || !u.openid) return;
      userMap[u.openid] = {
        openid: u.openid,
        nickname: u.nickname || ('酒友' + String(u.openid).slice(-4)),
        avatar: u.avatar || '',
      };
    });

    // pairNet[debtorId][creditorId] = net debt
    const pairNet = {}; // debtor -> creditor -> amount
    const totalDebt = {}; // debtor -> total net owed to all

    const addPair = (debtorId, creditorId, delta) => {
      if (!debtorId || !creditorId) return;
      if (!pairNet[debtorId]) pairNet[debtorId] = {};
      if (!pairNet[debtorId][creditorId]) pairNet[debtorId][creditorId] = 0;
      pairNet[debtorId][creditorId] += delta;
    };

    // 规则：
    // debt: kind='debt' & status='final'  => +amount
    // repay: kind='repay' & status='approved' => -amount
    tx.forEach(t => {
      const kind = t.kind || 'debt';      // 兼容旧数据：没kind当欠酒
      const status = t.status || 'final'; // 兼容旧数据：没status当final
      const debtorId = t.debtorId;
      const creditorId = t.creditorId;
      const amount = Number(t.amount) || 0;

      if (!debtorId || !creditorId || amount <= 0) return;

      if (kind === 'debt') {
        if (status === 'final') addPair(debtorId, creditorId, amount);
      } else if (kind === 'repay') {
        if (status === 'approved') addPair(debtorId, creditorId, -amount);
      }
    });

    // 汇总 totalDebt（debtor 对所有 creditor 的净欠）
    Object.keys(pairNet).forEach(debtorId => {
      let sum = 0;
      Object.keys(pairNet[debtorId]).forEach(creditorId => {
        sum += pairNet[debtorId][creditorId];
      });
      totalDebt[debtorId] = Math.max(0, Math.round(sum));
    });

    // 生成 players（给每个别人算：totalDebt + heOwesMe）
    const players = users.map(u => {
      const id = u.openid;
      const base = userMap[id] || { openid: id, nickname: '酒友' + String(id).slice(-4), avatar: '' };

      // heOwesMe：这个人欠我多少
      const heOwesMe = Math.max(0, Math.round((pairNet[id]?.[me] || 0)));

      return {
        ...base,
        totalDebt: totalDebt[id] || 0,
        heOwesMe,
      };
    });

    // 顶部 myOweTotal：我欠别人总数
    let myOweTotal = 0;
    const myPairs = pairNet[me] || {};
    Object.keys(myPairs).forEach(creditorId => {
      myOweTotal += myPairs[creditorId];
    });
    myOweTotal = Math.max(0, Math.round(myOweTotal));

    // 明细列表：我欠（按对方聚合） / 欠我（按对方聚合）
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

  // ---------------- repay approval popup (NO SPAM) ----------------
  maybePopupRepayApprove(allTx) {
    // 找出：对我发起的 pending repay
    const me = this.data.myOpenId;
    if (!me) return;
    if (this.data.showApproveModal) return; // 正在弹就别重复弹

    const seen = this.data.seenPendingIds || {};
    const pending = allTx
      .filter(t => (t.kind === 'repay') && (t.status === 'pending') && t.creditorId === me)
      // 稳定排序：按 createdAt（如果没有就按 _id）
      .sort((a, b) => {
        const t1 = this._toMillis(a.createdAt);
        const t2 = this._toMillis(b.createdAt);
        if (t1 !== t2) return t1 - t2;
        return String(a._id).localeCompare(String(b._id));
      });

    // 找第一条没弹过的
    const next = pending.find(t => !seen[t._id]);
    if (!next) return;

    // 标记为已展示（防止 watch 反复触发）
    seen[next._id] = true;
    wx.setStorageSync(this._seenKey(), seen);
    this.setData({ seenPendingIds: seen });

    // 准备展示内容
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

  onMeCardTap() {
    // 目前不用做事，预留
  },

  openDetailModal() {
    this.setData({ showDetailModal: true });
  },

  closeDetailModal() {
    this.setData({ showDetailModal: false });
  },

  manualRefresh() {
    // 手动触发一次 recompute（watch 已经会自动更新）
    this.recomputeAll();
    wx.showToast({ title: '已刷新', icon: 'none' });
  },

  changeUnit() {
    wx.showActionSheet({
      itemList: ['杯', '瓶', '口', 'Shot'],
      success: async res => {
        const units = ['杯', '瓶', '口', 'Shot'];
        const u = units[res.tapIndex] || '杯';
        this.setData({ currentUnit: u });
        try {
          await db.collection('rooms').doc(this.data.roomId).update({ data: { unit: u } });
        } catch (e) {
          console.error('update unit fail', e);
        }
      }
    });
  },

  async onGetProfileTap() {
    // 微信推荐使用 getUserProfile
    try {
      const res = await wx.getUserProfile({ desc: '用于显示头像昵称' });
      const nickname = res.userInfo?.nickName || '我';
      const avatar = res.userInfo?.avatarUrl || '';

      this.setData({
        hasProfile: true,
        myProfile: { nickname, avatar },
      });

      // 本机缓存
      wx.setStorageSync(this._profileKey(), { nickname, avatar });

      // 同步到 rooms.users 里（简单版：取出users整体替换）
      await this.updateMyProfileInRoom(nickname, avatar);
      wx.showToast({ title: '已授权', icon: 'success' });
    } catch (e) {
      console.error('getUserProfile fail', e);
      wx.showToast({ title: '未授权', icon: 'none' });
    }
  },

  async updateMyProfileInRoom(nickname, avatar) {
    const roomRef = db.collection('rooms').doc(this.data.roomId);
    try {
      const roomRes = await roomRef.get();
      const room = roomRes.data || {};
      const users = Array.isArray(room.users) ? room.users : [];
      const me = this.data.myOpenId;

      const newUsers = users.map(u => {
        if (!u || !u.openid) return u;
        if (u.openid !== me) return u;
        return { ...u, nickname, avatar };
      });

      await roomRef.update({ data: { users: newUsers } });
    } catch (e) {
      console.error('updateMyProfileInRoom fail', e);
    }
  },

  // 点击整张卡也可以打开“欠酒”弹窗（备用）
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

  // ---------------- write transactions ----------------
  async confirmInput() {
    const amount = Number(this.data.inputAmount) || 0;
    if (amount <= 0) {
      wx.showToast({ title: '请输入大于0的数量', icon: 'none' });
      return;
    }

    const mode = this.data.inputMode; // debt | repay
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
        // 欠酒：直接生效
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
        // 还酒：先 pending，等对方同意才抵扣
        await db.collection('transactions').add({
          data: {
            roomId: this.data.roomId,
            kind: 'repay',
            status: 'pending',
            debtorId: me,          // 还酒的人（原欠债人）
            creditorId: other.openid, // 债主（需要同意的人）
            amount,
            unit: this.data.currentUnit,
            debtorNickname: this.data.myProfile.nickname || '酒友',
            createdAt: db.serverDate(),
          }
        });
        wx.showToast({ title: '已申请还酒', icon: 'none' });
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
