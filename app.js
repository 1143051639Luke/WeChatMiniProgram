// app.js
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上基础库以使用云能力');
      return;
    }
    wx.cloud.init({
      env: 'cloud1-8gie68eu6b710c35', // ← 改这里
      traceUser: true
    });
  }
});