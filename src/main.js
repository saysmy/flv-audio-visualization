import Vue from 'vue'
import App from './App.vue'
import FlvAudioPlayer from './flvAudioPlayer.js'

Vue.config.productionTip = false

new Vue({
  render: h => h(App),
  mounted: function () {
    window.player = new FlvAudioPlayer({
      url: 'http://yourflvUrl.flv',
      mountId: 'canvas',
      r: 150,
      colors: ['#ff0000', '#fff', '#ff0'],
      debug: true
    })
  }
}).$mount('#app')
