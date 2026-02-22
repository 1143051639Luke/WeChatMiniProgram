// pages/index/index.js
Page({
  data: {
    busy: false,
    myOpenId: '',
    hasProfile: false,
    myProfile: { nickname: '', avatar: '' },
    joinRoomInput: '',
  },

  onLoad(options = {}) {
    this.initIdentity();
    if (options.ended === '1') {
      wx.showToast({ title: '本局已结束', icon: 'none' });
    }
  },

  _profileKey() {
    return `WineDebt_profile_${this.data.myOpenId || 'unknown'}`;
  },

  _currentRoomKey() {
    return `WineDebt_currentRoom_${this.data.myOpenId || 'unknown'}`;
  },

  _normalizeRoomId(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    return v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  },

  _createRoomId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `room_${ts}${rand}`;
  },

  _extractRoomIdFromScanResult(result = '') {
    const raw = String(result || '').trim();
    if (!raw) return '';

    const direct = this._normalizeRoomId(raw);
    if (direct.startsWith('room_')) return direct;

    const paramMatch = raw.match(/(?:^|[?&#])roomId=([^&#]+)/i);
    if (paramMatch && paramMatch[1]) {
      const fromParam = this._normalizeRoomId(decodeURIComponent(paramMatch[1]));
      if (fromParam) return fromParam;
    }

    const sceneMatch = raw.match(/(?:^|[?&#])scene=([^&#]+)/i);
    if (sceneMatch && sceneMatch[1]) {
      const decodedScene = decodeURIComponent(sceneMatch[1]);
      const nested = decodedScene.match(/(?:^|&)roomId=([^&]+)/i);
      if (nested && nested[1]) {
        const fromScene = this._normalizeRoomId(decodeURIComponent(nested[1]));
        if (fromScene) return fromScene;
      }
      const sceneDirect = this._normalizeRoomId(decodedScene);
      if (sceneDirect.startsWith('room_')) return sceneDirect;
    }

    return '';
  },

  _isGenericNickname(name) {
    const n = String(name || '').trim();
    return !n || n === '微信用户' || n === '用户';
  },

  _isProfileComplete(profile = this.data.myProfile) {
    const nickname = String(profile?.nickname || '').trim();
    const avatar = String(profile?.avatar || '').trim();
    return !this._isGenericNickname(nickname) && !!avatar;
  },

  _saveProfile(profile) {
    const p = {
      nickname: String(profile?.nickname || '').trim(),
      avatar: String(profile?.avatar || '').trim(),
    };
    if (this.data.myOpenId) {
      wx.setStorageSync(this._profileKey(), p);
    }
    this.setData({
      hasProfile: !!p.nickname,
      myProfile: p,
    });
  },

  loadLocalProfile() {
    if (!this.data.myOpenId) return;
    const p = wx.getStorageSync(this._profileKey()) || null;
    if (p && p.nickname) {
      this.setData({
        hasProfile: true,
        myProfile: {
          nickname: p.nickname || '',
          avatar: p.avatar || '',
        }
      });
      return;
    }
    this.setData({
      hasProfile: false,
      myProfile: { nickname: '', avatar: '' },
    });
  },

  async initIdentity() {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      wx.showToast({ title: '云能力不可用', icon: 'none' });
      return;
    }

    let openid = '';
    try {
      const res = await wx.cloud.callFunction({ name: 'login' });
      openid = res?.result?.openid || '';
      if (!openid) throw new Error('openid empty');
    } catch (e) {
      console.error('login fail', e);
      const testKey = 'WineDebt_testOpenId';
      openid = wx.getStorageSync(testKey);
      if (!openid) {
        openid = 'test_' + Date.now();
        wx.setStorageSync(testKey, openid);
      }
      wx.showToast({ title: '测试模式', icon: 'none' });
    }

    this.setData({ myOpenId: openid });
    this.loadLocalProfile();
  },

  async ensureAuthorized() {
    if (!this.data.myOpenId) {
      await this.initIdentity();
      if (!this.data.myOpenId) return false;
    }

    if (!this.data.hasProfile) {
      try {
        const res = typeof wx.getUserProfile === 'function'
          ? await wx.getUserProfile({ desc: '用于酒局记账显示昵称头像' })
          : await wx.getUserInfo();

        const nickname = res.userInfo?.nickName || '';
        const avatar = res.userInfo?.avatarUrl || '';
        this._saveProfile({ nickname, avatar });
      } catch (e) {
        console.error('authorize fail', e);
        wx.showToast({ title: '未授权无法使用', icon: 'none' });
        return false;
      }
    }

    if (!this._isProfileComplete()) {
      wx.showToast({ title: '请先设置昵称和头像', icon: 'none' });
      return false;
    }

    return true;
  },

  onChooseAvatar(e) {
    const avatar = String(e?.detail?.avatarUrl || '').trim();
    if (!avatar) return;
    const nickname = this.data.myProfile?.nickname || '';
    this._saveProfile({ nickname, avatar });
  },

  onNicknameInput(e) {
    const nickname = String(e?.detail?.value || '').trim().slice(0, 20);
    const avatar = this.data.myProfile?.avatar || '';
    this.setData({ myProfile: { nickname, avatar } });
  },

  saveNickname() {
    const nickname = String(this.data.myProfile?.nickname || '').trim().slice(0, 20);
    if (!nickname) return;
    const avatar = this.data.myProfile?.avatar || '';
    this._saveProfile({ nickname, avatar });
  },

  onJoinRoomInput(e) {
    this.setData({ joinRoomInput: String(e?.detail?.value || '') });
  },

  goRoom(roomId) {
    const normalized = this._normalizeRoomId(roomId);
    if (!normalized) return;

    wx.setStorageSync(this._currentRoomKey(), normalized);
    const encoded = encodeURIComponent(normalized);
    wx.redirectTo({
      url: `/pages/room/room?roomId=${encoded}`,
    });
  },

  async startNewGame() {
    if (this.data.busy) return;
    this.setData({ busy: true });

    try {
      const ok = await this.ensureAuthorized();
      if (!ok) return;
      const roomId = this._createRoomId();
      this.goRoom(roomId);
    } finally {
      this.setData({ busy: false });
    }
  },

  async joinByRoomCode() {
    if (this.data.busy) return;
    this.setData({ busy: true });

    try {
      const ok = await this.ensureAuthorized();
      if (!ok) return;

      const roomId = this._normalizeRoomId(this.data.joinRoomInput);
      if (!roomId) {
        wx.showToast({ title: '请输入房间码', icon: 'none' });
        return;
      }
      this.goRoom(roomId);
    } finally {
      this.setData({ busy: false });
    }
  },

  async scanJoinGame() {
    if (this.data.busy) return;
    this.setData({ busy: true });

    try {
      const ok = await this.ensureAuthorized();
      if (!ok) return;

      wx.scanCode({
        onlyFromCamera: false,
        scanType: ['qrCode'],
        success: res => {
          const roomId = this._extractRoomIdFromScanResult(res.result);
          if (!roomId) {
            wx.showToast({ title: '二维码无效', icon: 'none' });
            return;
          }
          this.goRoom(roomId);
        },
        fail: err => {
          if (err && err.errMsg && err.errMsg.includes('cancel')) return;
          console.error('scanCode fail', err);
          wx.showToast({ title: '扫码失败', icon: 'none' });
        },
        complete: () => {
          this.setData({ busy: false });
        }
      });
      return;
    } catch (e) {
      console.error('scanJoinGame fail', e);
      wx.showToast({ title: '操作失败', icon: 'none' });
    }

    this.setData({ busy: false });
  },
});
