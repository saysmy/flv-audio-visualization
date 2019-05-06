/**
 * 用于解析播放纯flv音频流，并提供可视化的音频波形图
 *
 * @author smy
 * @date 2019-04-26

AudioContext.createBufferSource()
创建一个 AudioBufferSourceNode 对象, 他可以通过 AudioBuffer 对象来播放和处理包含在内的音频数据. AudioBuffer可以通过 AudioContext.createBuffer 方法创建或者使用 AudioContext.decodeAudioData 方法解码音轨来创建。

AudioContext.createMediaElementSource()
创建一个MediaElementAudioSourceNode接口来关联HTMLMediaElement. 这可以用来播放和处理来自<video>或<audio> 元素的音频.

AudioContext.createMediaStreamSource()
创建一个 MediaStreamAudioSourceNode 接口来关联可能来自本地计算机麦克风或其他来源的音频流 MediaStream.
*/

import FLVDemuxer from './flvdemuxer.js'

class flvAudioPlayer {
  constructor (config) {
    let def = {
      // http://hdl.wsdemo.zego.im/livestream/zegotest-2854705954-1389839.flv
      url: '', // flv音频地址，只支持纯音频，不支持音视频混合
      mountId: '', // 音频频谱挂载dom的id， 没有则不绘制，值播放音频
      r: 150, // 绘制频谱的圆形半径, 圆居于挂在dom的中间
      colors: ['#0f0', '#ff0', '#f00'], // 柱形的颜色，多个色值时为渐变色
      setVolumeCallback: function () {}, // 设置音量的回调，用于同步多个音频对象的音量调整
      debug: false // 是否打开调试模式
    }
    this.config = Object.assign({}, def, config)
    this.debug = this.config.debug
    this.isDestroy = false // 标志是否销毁对象

    this.flvDemuxerObj = null // flvDemuxer实例对象
    this.flvProbeDataObj = null // flvProbeData对象

    this.flvHeader = null // first 9bytes ,flv header 9bytes
    this.isFirstParse = true // 是否处于第一次解析音频过程
    this.delayStartTime = 0 // 音频播放的延迟开始时间

    window.AudioContext = window.AudioContext || window.webkitAudioContext || window.mozAudioContext
    this.audioCtx = new AudioContext()

    // GainNode 接口表示音量变更，是一个 AudioNode 音频处理模块，音量控制
    this.gainNode = this.audioCtx.createGain()

    // AudioContext 的 createAnalyser()方法能创建一个AnalyserNode，可以用来获取音频时间和频率数据，以及实现数据可视化。
    this.analyser = this.audioCtx.createAnalyser()
    this.analyser.fftSize = 1024

    // 存放已解码完毕待播放音频的数组
    this.audioStack = []
    // audio是否正在播放
    this.audioPlaying = false

    // 开始请求流数据
    this.getBuffer()
    if (this.config.mountId !== '') {
      // 初始化波形图
      this.initAudioWave()
    }
  }

  /**
	 * 初始化flv分流器
	 *
	 * @author smy
	 * @date 2019-04-26
	 * @param {*} flv
	 * @param {*} aacCallback
	 * @returns
	 * @memberof flvAudioPlayer
	 */
  initFlvdemuxer (flv, aacCallback) {
    let _this = this
    this.flvProbeDataObj = FLVDemuxer.probe(flv)
    this.flvDemuxerObj = new FLVDemuxer(this.flvProbeDataObj)

    this.metadata = null
    this.flvDemuxerObj.onTrackMetadata = (type, _metaData) => {
      if (type == 'audio') {
        _this.debugFunc('_metaData:', _metaData)
        _this.metadata = _metaData
      }
    }
    this.flvDemuxerObj.onMediaInfo = (e) => {
      _this.debugFunc('onMediaInfo:', e)
    }
    this.flvDemuxerObj.onDataAvailable = (...args) => {
      // args: [{ type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0 }]
      args.forEach(data => {
        if (data.type == 'audio') {
          aacCallback(data)
        }
      })
    }
    this.flvDemuxerObj.onError = (e) => {
      throw new Error(e)
    }
  }

  getBuffer () {
    let _this = this
    if (this.audioCtx) {
      // Fetch中的Response.body实现了getReader()方法用于渐增的读取原始字节流
      // 处理器函数一块一块的接收响应体，而不是一次性的。当数据全部被读完后会将done标记设置为true。 在这种方式下，每次你只需要处理一个chunk，而不是一次性的处理整个响应体。
      this.debugFunc('Fetch stream start')
      // Feature detect
      let signal
      if ('AbortController' in window) {
        this.controller = new AbortController()
        signal = this.controller.signal
      }

      let myRequest = new Request(this.config.url)
      fetch(myRequest, {
        method: 'GET',
        signal
      })
        .then(
          response => {
            _this.debugFunc('Read stream and decode')
            _this._pump(response.body.getReader())
          },
          error => {
            console.error('audio stream fetch Error:', error)
          }
        )
        .catch((e) => {
          console.log('e:', e)
        })
    } else {
      console.error('Not support AudioContext!')
      alert('Not support AudioContext!')
    }
  }

  _pump (reader) {
    var _this = this
    return reader.read()
      .then(
        ({ value, done }) => {
          if (done) {
            _this.debugFunc('Stream reader done')
          } else {
            _this.debugFunc('[FetchStream]:', value.buffer)
            // value 为uint8Array, value.buffer为 arrayBuffer
            // 为trunk添加flv头部方便flvDemuxer识别
            let chunk = _this.addFlvHeader(value.buffer)

            // 首次解析时，初始化flvdemuxer，之后再解析流不需要再次初始化，只需要解析相应的流即可
            if (_this.isFirstParse) {
              _this.debugFunc('Init Flv DEMUXER')
              _this.isFirstParse = false
              _this.initFlvdemuxerAndCallback(chunk)
            }

            // 清空audio之前的metadata数据
            _this.flvDemuxerObj._audioMetadata = null
            // 此为清除之前的audio流，得到fetch流对应的音频;若不清除，parseChunk后得到的是从开始累积的aac数据
            _this.flvDemuxerObj._audioTrack = { type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0 }

            // 提取音频数据aac
            _this.parseChunks(chunk)

            // 获取下一个chunk
            if (!_this.isDestroy) {
              _this._pump(reader)
            }
          }
        })
      .catch((e) => {
        console.log('[flv audio]reader stream:', e)
      })
  }

  /**
	 * 解析fetch流的每个trunk
	 *
	 * @param {audioBuffer} flv
	 * @memberof flvAudioPlayer
	 */
  parseChunks (flv) {
    if (this.debug) {
      this.debugFunc('开始解析flvtrunk:', flv)
    }
    var finalOffset = this.flvDemuxerObj.parseChunks(flv, this.flvProbeDataObj.dataOffset)
    if (finalOffset != flv.byteLength) {
      console.warn('FLVDemuxer: unexpected EOF')
    }
  }

  /**
	 * 初始化flv分流器和解码回调，对fetch reader的每一个trunk进行解码，对解码后的tag进行音频处理封装，处理后交给回调，回调累积音频tag到一定量，交给audioCtx解码播放
	 * @param {*} chunk
	 */
  initFlvdemuxerAndCallback (chunk) {
    let _this = this
    let flvDecodeTime = 0
    // 用于暂时存储flvDemuxer处理后累积的音频数据
    let audioStackArray = null
    this.initFlvdemuxer(chunk, function (aac) {
      // onDataAvailable回调
      // 合并aac tag
      audioStackArray = _this.concatAudioArray(audioStackArray, aac)
      if (flvDecodeTime < 5) {
        flvDecodeTime++
        return
      }

      if (_this.debug) {
        _this.debugFunc('Add aac header')
      }
      let decodeAudioArray = _this.getNewAac(audioStackArray)
      audioStackArray = null
      flvDecodeTime = 0

      if (_this.debug) {
        _this.debugFunc('start Decode Audio Data')
      }
      // decodeAudioData 第一个参数需要是arrayBuffer格式
      _this.audioCtx.decodeAudioData(decodeAudioArray.buffer, function (buffer) {
        // 将音频数据压入数组，等待播放
        _this.audioStack.push(buffer)
        if (_this.debug) {
          _this.debugFunc('audio压入audioStack：', _this.audioStack)
        }
        if (!_this.audioPlaying) {
          // 开始播放音频
          _this.loopPlayBuffers()
        }
      }, function (e) {
        console.error('decodeAudioData fail:', e)
      })
    })
  }

  /**
	 * 循环播放audioStack中的音频
	 */
  loopPlayBuffers () {
    var _this = this
    if (this.debug) {
      this.debugFunc('audioStack:', this.audioStack)
    }
    if (this.audioStack.length == 0) {
      console.warn('audioStack为空，等待audio入栈（音频解析速度慢或遇到问题）')
      this.delayStartTime = (new Date()).getTime()
      this.audioPlaying = false
      return
    }

    if (this.delayStartTime !== 0) {
      let nowTime = (new Date()).getTime()
      let gap = nowTime - this.delayStartTime
      this.delayStartTime = 0
      this.debugFunc('延迟时间：' + gap + ' ms')
    }

    var buffer = this.audioStack.shift()
    this.audioPlaying = true
    if (this.debug) {
      this.debugFunc('audioStack出栈，播放音频: ', buffer, buffer.duration)
    }

    if (audioBufferSourceNode) {
      audioBufferSourceNode.stop(0)
    }

    var audioBufferSourceNode = this.audioCtx.createBufferSource()
    audioBufferSourceNode.connect(this.analyser)
    // AudioContext.destination 只读返回AudioDestinationNode对象，表示当前audio context中所有节点的最终节点，一般表示音频渲染设备。
    this.analyser.connect(this.audioCtx.destination)
    audioBufferSourceNode.buffer = buffer
    audioBufferSourceNode.start(0, 0, buffer.duration)

    // 连接到音频处理模块
    audioBufferSourceNode.connect(this.gainNode)
    this.gainNode.connect(this.audioCtx.destination)

    // 绘制波形
    if (!this.isPainting && this.config.mountId !== '') {
      this.renderWave()
    }

    audioBufferSourceNode.onended = function (e) {
      if (_this.debug) {
        _this.debugFunc('audioBufferSourceNode.onended')
      }
      _this.loopPlayBuffers()
    }
  }

  /**
	 *  每一个被解析的flv trunk需要有一个header头部，标志flv的一些基本信息
	 * @param {*} chunk
	 * @returns audioBuffer
	 */
  addFlvHeader (chunk) {
    let audioBuffer = null
    if (this.flvHeader == null) {
      // copy first 9 bytes (flv header)
      this.flvHeader = chunk.slice(0, 9)
      audioBuffer = chunk
    } else {
      audioBuffer = this.appendBuffer(this.flvHeader, chunk)
    }
    return audioBuffer
  }

  /**
	 * 合并buffer: Uint8Array
	 */
  appendBuffer (buffer1, buffer2) {
    let tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength)
    tmp.set(new Uint8Array(buffer1), 0)
    tmp.set(new Uint8Array(buffer2), buffer1.byteLength)
    return tmp.buffer
  }

  /**
	 * 获取添加adts头部信息的aac数据
	 *
	 * @param {*} metadata
	 * @param {*} aac
	 * @returns
	 * @memberof flvAudioPlayer
	 */
  getNewAac (aac) {
    const {
      audioObjectType,
      samplingFrequencyIndex,
      channelCount: channelConfig
    } = this.metadata

    let output = []
    let _this = this
    // aac音频需要增加adts头部后才能被解析播放
    aac.samples.forEach((sample) => {
      const headers = _this.getAdtsHeaders({
        audioObjectType,
        samplingFrequencyIndex,
        channelConfig,
        adtsLen: sample.length + 7
      })
      output.push(...headers, ...sample.unit)
    })

    return new Uint8Array(output)
  }

  /**
	* 计算adts头部, aac文件需要增加adts头部才能被audioContext decode
	* @typedef {Object} AdtsHeadersInit
	* @property {number} audioObjectType
	* @property {number} samplingFrequencyIndex
	* @property {number} channelConfig
	* @property {number} adtsLen
	* @param {AdtsHeadersInit} init
	* 添加aac头部参考：https://github.com/Xmader/flv2aac/blob/master/main.js
	*/
  getAdtsHeaders (init) {
    const { audioObjectType, samplingFrequencyIndex, channelConfig, adtsLen } = init
    const headers = new Uint8Array(7)

    headers[0] = 0xff // syncword:0xfff                           高8bits
    headers[1] = 0xf0 // syncword:0xfff                           低4bits
    headers[1] |= (0 << 3) // MPEG Version:0 for MPEG-4,1 for MPEG-2   1bit
    headers[1] |= (0 << 1) // Layer:0                                  2bits
    headers[1] |= 1 // protection absent:1                      1bit

    headers[2] = (audioObjectType - 1) << 6 // profile:audio_object_type - 1                      2bits
    headers[2] |= (samplingFrequencyIndex & 0x0f) << 2 // sampling frequency index:sampling_frequency_index  4bits
    headers[2] |= (0 << 1) // private bit:0                                      1bit
    headers[2] |= (channelConfig & 0x04) >> 2 // channel configuration:channel_config               高1bit

    headers[3] = (channelConfig & 0x03) << 6 // channel configuration：channel_config     低2bits
    headers[3] |= (0 << 5) // original：0                               1bit
    headers[3] |= (0 << 4) // home：0                                   1bit
    headers[3] |= (0 << 3) // copyright id bit：0                       1bit
    headers[3] |= (0 << 2) // copyright id start：0                     1bit

    headers[3] |= (adtsLen & 0x1800) >> 11 // frame length：value    高2bits
    headers[4] = (adtsLen & 0x7f8) >> 3 // frame length：value    中间8bits
    headers[5] = (adtsLen & 0x7) << 5 // frame length：value    低3bits
    headers[5] |= 0x1f // buffer fullness：0x7ff 高5bits
    headers[6] = 0xfc

    return headers
  }

  /**
	 * 合并flvDemuxer处理后的音频tag
	 *
	 * @param {*} target
	 * @param {*} source
	 * @returns
	 * @memberof flvAudioPlayer
	 */
  concatAudioArray (target, source) {
    if (typeof target !== 'object') {
      console.error('target must be an object!')
      return
    }
    if (target) {
      let _tem = { type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0 }
      _tem.length = source.length + target.length
      _tem.samples = target.samples.concat(source.samples)
      return _tem
    } else {
      return source
    }
  }

  initAudioWave () {
    this.config.wave = {
      PI: Math.PI,
      cr: this.config.r, // 环形半径
      minHeight: 1, // 柱形的最矮高度
      meterWidth: 2, // 每个柱形的宽
      meterNum: 360, // 圆周分为多少段进行绘制柱形
      isPainting: true
    }

    let canvas = document.getElementById(this.config.mountId)
    this.config.wave.ctx = canvas.getContext('2d')
    this.config.wave.cwidth = canvas.width
    this.config.wave.cheight = canvas.height

    let gradient = this.config.wave.ctx.createLinearGradient(0, -this.config.wave.cr, 0, -this.config.wave.cwidth / 2)

    let colorStep = (1 / this.config.colors.length).toFixed(2)
    this.config.colors.map(function (value, index) {
      gradient.addColorStop(index * colorStep, value)
    })

    this.config.wave.ctx.fillStyle = gradient

    this.renderWave()
  }

  renderWave () {
    if (this.isDestroy) {
      return
    }

    if (!this.audioPlaying) {
      this.isPainting = false
      return
    }
    this.isPainting = true

    let wave = this.config.wave
    // frequencyBinCount 的值固定为 AnalyserNode 接口中fftSize值的一半. 该属性通常用于可视化的数据值的数量.
    // fftSize越大，可视化的数据值的数量越多，显示的波形越细密
    // 当音频无数据时，array中的值均为0
    // 每一个字节最大为2的8次方，256
    let meterNum = wave.meterNum
    // 创建frequencyBinCount长度的Uint8Array数组，用于存放音频数据
    let array = new Uint8Array(this.analyser.frequencyBinCount)
    // 将音频数据填充到数组当中
    this.analyser.getByteFrequencyData(array)

    // 计算采样步长
    var step = Math.round(array.length / meterNum)

    wave.ctx.clearRect(0, 0, wave.cwidth, wave.cheight)
    wave.ctx.save()
    // 移动中心点到圆心
    wave.ctx.translate(wave.cwidth / 2, wave.cheight / 2)
    for (let i = 0; i < meterNum; i++) {
      // ctx.save();
      let value = array[i * step]
      // wave.cheight / 2 - wave.cr 为波形的最大高度
      let meterHeight = value * (wave.cheight / 2 - wave.cr) / 256 || wave.minHeight
      // 根据圆心为中心点旋转
      wave.ctx.rotate((360 / meterNum) * (wave.PI / 180))
      wave.ctx.fillRect(-wave.meterWidth / 2, -wave.cr - meterHeight, wave.meterWidth, meterHeight)
      // ctx.restore();
    }
    wave.ctx.restore()
    requestAnimationFrame(this.renderWave.bind(this))
  }

  destroy () {
    this.isDestroy = true
    // 停止fetch stream
    if (this.controller) {
      this.controller.abort()
    }
    // 清空画布
    this.config.wave.ctx.clearRect(0, 0, this.config.wave.cwidth, this.config.wave.cheight)
  }

  /**
	 * 调节声音大小
	 *
	 * @param {*} num [0, ~]， 0： 静音
	 * @memberof flvAudioPlayer
	 */
  setVolume (num) {
    this.volume = num
  }

  set volume (num) {
    this.gainNode.gain.value = num * 2 - 1
    // 设置音量的回调
    this.config.setVolumeCallback(num)
  }

  // 获取声音大小
  get volume () {
    return (this.gainNode.gain.value + 1) / 2
  }

  debugFunc (msg, ...obj) {
    obj = obj || []
    if (console && console.log) {
      if (typeof msg === 'string') {
        let d = new Date()
        let newMsg = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours() + ':' + d.getMinutes() + ':' + d.getSeconds() + ':' + d.getMilliseconds() + ' ' + msg
        let _tem = []
        _tem.push(newMsg)
        _tem = _tem.concat(obj)
        console.log.apply(this, _tem)
      } else {
        console.log(msg)
      }
    }
  }

  // 打开弹幕
  openBarrage () {
    if (this.barrage) {
      this.barrage.openDanmu()
    }
  }
  // 关闭弹幕
  closeBarrage () {
    if (this.barrage) {
      this.barrage.closeDanmu()
    }
  }

  barrageObj (callback) {
    var _this = this
    // 初始化弹幕
    require.async('barrage', function (barrage) {
      _this.barrage = new barrage()
      callback(_this.barrage)
    })
  }
}

export default flvAudioPlayer
