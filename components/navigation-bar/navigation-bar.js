Component({
  options: {
    multipleSlots: true // 在组件定义时的选项中启用多slot支持
  },
  /**
   * 组件的属性列表
   */
  properties: {
    extClass: {
      type: String,
      value: ''
    },
    title: {
      type: String,
      value: ''
    },
    background: {
      type: String,
      value: ''
    },
    color: {
      type: String,
      value: ''
    },
    back: {
      type: Boolean,
      value: true
    },
    loading: {
      type: Boolean,
      value: false
    },
    homeButton: {
      type: Boolean,
      value: false,
    },
    animated: {
      // 显示隐藏的时候opacity动画效果
      type: Boolean,
      value: true
    },
    show: {
      // 显示隐藏导航，隐藏的时候navigation-bar的高度占位还在
      type: Boolean,
      value: true,
      observer: '_showChange'
    },
    // back为true的时候，返回的页面深度
    delta: {
      type: Number,
      value: 1
    },
  },
  /**
   * 组件的初始数据
   */
  data: {
    displayStyle: ''
  },
  lifetimes: {
    attached() {
      const systemInfo = wx.getSystemInfoSync()
      const rect = typeof wx.getMenuButtonBoundingClientRect === 'function'
        ? wx.getMenuButtonBoundingClientRect()
        : { left: systemInfo.windowWidth || 375 }
      const deviceInfo = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : systemInfo
      const windowInfo = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : systemInfo
      const platform = deviceInfo.platform || ''
      const isAndroid = platform === 'android'
      const isDevtools = platform === 'devtools'
      const safeArea = windowInfo.safeArea || {}
      const top = safeArea.top || 0
      const windowWidth = windowInfo.windowWidth || 375
      const menuLeft = typeof rect.left === 'number' ? rect.left : windowWidth
      const sideWidth = Math.max(0, windowWidth - menuLeft)
      this.setData({
        ios: !isAndroid,
        innerPaddingRight: `padding-right: ${sideWidth}px`,
        leftWidth: `width: ${sideWidth}px`,
        safeAreaTop: isDevtools || isAndroid ? `height: calc(var(--height) + ${top}px); padding-top: ${top}px` : ``
      })
    },
  },
  /**
   * 组件的方法列表
   */
  methods: {
    _showChange(show) {
      const animated = this.data.animated
      let displayStyle = ''
      if (animated) {
        displayStyle = `opacity: ${show ? '1' : '0'
          };transition:opacity 0.5s;`
      } else {
        displayStyle = `display: ${show ? '' : 'none'}`
      }
      this.setData({
        displayStyle
      })
    },
    back() {
      const data = this.data
      if (data.delta) {
        wx.navigateBack({
          delta: data.delta
        })
      }
      this.triggerEvent('back', { delta: data.delta }, {})
    },
    home() {
      wx.reLaunch({
        url: '/pages/room/room'
      })
      this.triggerEvent('home', {}, {})
    }
  },
})
