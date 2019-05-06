import Vue from 'vue'
import App from './App.vue'
import FLVDemuxer from './flvdemuxer.js'

(function () {
  Vue.config.productionTip = false

  new Vue({
    render: h => h(App)
  }).$mount('#app')

  window.AudioContext = window.AudioContext || window.webkitAudioContext || window.mozAudioContext
  var audioCtx = new AudioContext()

  var flvDemuxerObj = null // flvDemuxer实例对象
  var flvProbeDataObj = null // flvProbeData对象

  /**
* 计算adts头部
* @typedef {Object} AdtsHeadersInit
* @property {number} audioObjectType
* @property {number} samplingFrequencyIndex
* @property {number} channelConfig
* @property {number} adtsLen
* @param {AdtsHeadersInit} init
*/
  const getAdtsHeaders = (init) => {
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

  function FLV2AAC (flv) {
    console.log('开始解析flvtrunk:', flv)
    flvDemuxerObj.parseChunks(flv, flvProbeDataObj.dataOffset)
    // const finalOffset = flvDemuxerObj.parseChunks(flv, flvProbeDataObj.dataOffset)
  /*   if (finalOffset != flv.byteLength) {
        throw new Error("FLVDemuxer: unexpected EOF")
    } */
  }
  // var isFirstParse2 = true
  function initFlvdemuxer (flv, aacCallback) {
    flvProbeDataObj = FLVDemuxer.probe(flv)
    var flvDemuxer = new FLVDemuxer(flvProbeDataObj)
    // console.log('flvProbeDataObj:', flvProbeDataObj)
    // console.log('flvDemuxer:', flvDemuxer)

    /*   if (isFirstParse2) {
	  isFirstParse2 = false
  } else {
    flvDemuxer._firstParse = false
  } */
    /**
   * @typedef {Object} Sample
   * @property {Uint8Array} unit
   * @property {number} length
   * @property {number} dts
   * @property {number} pts
   */

    /** @type {{ type: "audio"; id: number; sequenceNumber: number; length: number; samples: Sample[]; }} */
    let aac = null
    let metadata = null
    let newAac = null

    flvDemuxer.onTrackMetadata = (type, _metaData) => {
    // console.log('onTrackMetadata:', _metaData)
      if (type == 'audio') {
        metadata = _metaData
      }
    }

    flvDemuxer.onMediaInfo = (e) => {
    // console.log('onMediaInfo:', e)
    }

    flvDemuxer.onError = (e) => {
      throw new Error(e)
    }

    flvDemuxer.onDataAvailable = (...args) => {
    // console.log('onDataAvailable:', args)
      args.forEach(data => {
        if (data.type == 'audio') {
        // 这里的data为累积后的data，即包含之前parse的音频数据
          aac = data
          console.log('将被添加adts头部的aac:', data)
          newAac = getNewAac(metadata, aac)
          aacCallback(newAac)
        }
      })
    }

    return flvDemuxer
  }

  function getNewAac (metadata, aac) {
    const {
      audioObjectType,
      samplingFrequencyIndex,
      channelCount: channelConfig
    } = metadata

    let output = []
    /** @type {number[]} */
    // aac音频需要增加adts头部后才能被解析播放
    aac.samples.forEach((sample) => {
      const headers = getAdtsHeaders({
        audioObjectType,
        samplingFrequencyIndex,
        channelConfig,
        adtsLen: sample.length + 7
      })
      output.push(...headers, ...sample.unit)
    })

    return new Uint8Array(output)
  }

  function appendBuffer (buffer1, buffer2) {
    var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength)
    tmp.set(new Uint8Array(buffer1), 0)
    tmp.set(new Uint8Array(buffer2), buffer1.byteLength)
    return tmp.buffer
  }

  function getBuffer (link, callback) {
    if (audioCtx) {
    // Fetch中的Response.body实现了getReader()方法用于渐增的读取原始字节流
    // 处理器函数一块一块的接收响应体，而不是一次性的。当数据全部被读完后会将done标记设置为true。 在这种方式下，每次你只需要处理一个chunk，而不是一次性的处理整个响应体。
      var myRequest = new Request(link)
      var header = null // first 9bytes ,flv header 9bytes
      var isFirstParse = true

      fetch(myRequest, {
        method: 'GET'
      }).then(
        response => {
          const reader = response.body.getReader()
          _pump(reader)
        },
        error => {
          console.error('fetch Error:', error)
        }
      )

      let stashArray = null
      let fetchReaderTime = 0
      // eslint-disable-next-line no-inner-declarations
      function _pump (reader) {
        let chunk
        return reader.read().then(({ value, done }) => {
          if (done) {
            debug(' reader done')
          } else {
            // console.log('原始value:', value)
            if (stashArray) {
              stashArray = concat(Uint8Array, stashArray, value)
            } else {
              stashArray = concat(Uint8Array, value)
            }
            // console.log('stashArray:', stashArray)
            // console.log('stashArray length:', stashArray.byteLength)
            let maxFetchLength
            // console.log('fetchReaderTime:', fetchReaderTime)
            if (fetchReaderTime < 100) {
              maxFetchLength = 1000
            } else {
            }
            maxFetchLength = 20000

            if (stashArray.byteLength < maxFetchLength) {
              console.log('fetching')
              _pump(reader)
              return
            } else {
              chunk = stashArray.buffer
              stashArray = null
            }

            debug('======开始音频解码播放=======')

            debug('添加flv header头部')
            var audioBuffer = null
            if (header == null) {
              // copy first 9 bytes (flv header)
              header = chunk.slice(0, 9)
              audioBuffer = chunk
            } else {
              // console.log('chunk:', chunk)
              // console.log('header:', header)
              audioBuffer = appendBuffer(header, chunk)
		      }
            chunk = audioBuffer

            // 首次解析时，初始化flvdemuxer，之后再解析流不需要再次初始化，只需要解析相应的流即可
            if (isFirstParse) {
              debug('init Flv DEMUXER')
              isFirstParse = false

              flvDemuxerObj = initFlvdemuxer(chunk, function (aac) {
                // 解码音轨来创建 ArrayBuffer
                // result.value 为uint8Array, result.value.buffer为 arrayBuffer
                debug('合并aac tag')
                audioCtx.decodeAudioData(aac.buffer, function (buffer) {
                // console.log('decode后AudioData:', buffer)
                  callback(buffer)
                }, function (e) {
                // console.log('reject')
                })
              })
            }

            // 清空audio之前的metadata数据
            flvDemuxerObj._audioMetadata = null

            // 此为清除之前的audio流，得到fetch流对应的音频
            // flvDemuxerObj._audioTrack = { type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0 }

            // arrayData 为unit8Array格式，其属性值buffer为arrayBuffer格式，decodeAudioData 第一个参数需要是arrayBuffer格式
            // 提取音频数据aac
            FLV2AAC(chunk)
            // 获取下一个chunk
            _pump(reader)
          }
        })
      }
    } else {
      alert('not support AudioContext')
    }
  }

  window.onload = function () {
  /*
		  AudioContext.createBufferSource()
		  创建一个 AudioBufferSourceNode 对象, 他可以通过 AudioBuffer 对象来播放和处理包含在内的音频数据. AudioBuffer可以通过 AudioContext.createBuffer 方法创建或者使用 AudioContext.decodeAudioData 方法解码音轨来创建。

		  AudioContext.createMediaElementSource()
		  创建一个MediaElementAudioSourceNode接口来关联HTMLMediaElement. 这可以用来播放和处理来自<video>或<audio> 元素的音频.

		  AudioContext.createMediaStreamSource()
		  创建一个 MediaStreamAudioSourceNode 接口来关联可能来自本地计算机麦克风或其他来源的音频流 MediaStream.
	  */

    // AudioContext 的 createAnalyser()方法能创建一个AnalyserNode，可以用来获取音频时间和频率数据，以及实现数据可视化。
    var analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512

    var audioStack = []
    var bufferPlaying = false

    getBuffer('http://yourFlvUrl.flv', function (buffer) {
      debug('音频压入audioStack')
      console.log('开始播放音频:', buffer)

      audioStack.push(buffer)
      if (!bufferPlaying) {
        scheduleBuffers()
      }
    })

    // 音频开始播放的偏移时间值
    var offsetDuration = 0
    var lastStartTime = 0
    var hasFetchDelay = false // 是否有请求延迟，网络请求时长（包括编解码）大于请求回的资源播放时长
    var delayStartTime = 0
    var lastDuration = 0 // 上一次播放的片段时长
    async function scheduleBuffers () {
      console.log('audioStack:', audioStack)
      if (audioStack != []) {
        var buffer = audioStack.shift()
        if (!buffer) {
          bufferPlaying = false
          return
        }
        bufferPlaying = true

        debug('==============audioStack出栈，尝试播放音频==============')
        debug('播放的buffer: ' + buffer)
        if (typeof (audioBufferSourceNode) !== 'undefined') {
          audioBufferSourceNode.stop(0)
        }

        console.log('typeof (audioBufferSourceNode): ', audioBufferSourceNode)

        console.log('初始化audioBufferSourceNode')
        var audioBufferSourceNode = audioCtx.createBufferSource()
        audioBufferSourceNode.connect(analyser)
        // AudioContext.destination 只读返回AudioDestinationNode对象，表示当前audio context中所有节点的最终节点，一般表示音频渲染设备。
        analyser.connect(audioCtx.destination)

        audioBufferSourceNode.buffer = buffer

        let nowTime = (new Date()).getTime()
        if (lastStartTime !== 0) {
          offsetDuration = (offsetDuration * 1000 + nowTime - lastStartTime) / 1000
        }
        console.log('delay time:', nowTime - lastStartTime + ' ms')
        lastStartTime = nowTime

        // 规则：
        // 对于直播流，无论offsetDuration在什么位置，下一次的播放，都要从offset开始
        // 对于点播，则需要从上一次的有效音频点开始播放，即如果offsetDuration处无音频，需要寻找上一次音频的结束点，那此点开始播放

        // 新的视频流在当前视频流播放完后依然未拉取到，出现断流情况
        // 断流时长=本次偏移时长 - 上次视频流时长
        let breakPointDuration = offsetDuration - lastDuration
        let hasBreakPoint = breakPointDuration >= 0
        // 此操作会导致：1. 音频播放顺畅，不会断点  2. 直播出现延迟
        // offsetDuration = hasBreakPoint ? lastDuration : offsetDuration

        console.log('lastDuration:', lastDuration)
        // 其中一个原因为fetch拉流遇外界因素问题导拉流时间过长，导致运行scheduleBuffers函数的时刻nowTime变大，此时中间有scheduleBuffers函数的运行停止，等待拉流结束重新运行解析音频
        // 当前流长度小于offset，且offset>lastDuration，且当前流长度大于上次流长度时，不能从上一次流结尾处开始播放，这样会导致直播延迟，此时需要丢帧，丢弃上次一播放结束到符合条件的offset开始处的时长
        debug('buffer.duration: ' + buffer.duration)
        debug('本次播放开始时间offsetDuration: ' + offsetDuration)
        if (buffer.duration < offsetDuration) {
          debug('无效流，拉取流时长不足buffer.duration < offsetDuration')
          hasFetchDelay = true
          // delay的第一次循环
          if (delayStartTime == 0) {
            delayStartTime = offsetDuration
          }
          // 主要解决 buffer.duration < offsetDuration 不断循环，导致相差值越来越大，音频不再继续播放的问题，此时直播和点播同样的处理方式
          // 这里取 第一次延迟的时间点，只要当前音频时长大于第一次的延迟点，就可以以此点为播放起点，如果是直播流，此时会产生播放延迟
          if (buffer.duration <= delayStartTime) {
            debug('流时长不足，继续下一个buffer')
            scheduleBuffers()
            return
          } else {
            console.warn('产生流延迟，延迟时间：', offsetDuration - delayStartTime)
            offsetDuration = delayStartTime
          }
        } else if (hasFetchDelay) {
        // 此时播放起始点为offsetduration，而非上面的 delayStartTime, 因为此时音频流足以播放，不会造成拉取循环
        // offsetDuration = delayStartTime  // 对点播来说，不需要减少延迟，尽可能的衔接每个音频tag
          console.warn('产生流延迟，延迟时间：', offsetDuration - delayStartTime)
        }

        if (hasBreakPoint) {
          debug('断流时长：' + breakPointDuration)
        }

        if (hasFetchDelay && !hasBreakPoint) {
        // 此种情况不应该出现, 此时非断流情况，在flv解析后的流长度小于上一次的长度的时候
          console.warn('异常流，第二次的流长度小于第一次的流长度，相差时间为：', offsetDuration - lastDuration)
        }
        delayStartTime = 0
        hasFetchDelay = false

        lastDuration = buffer.duration

        // 每次音频都包含上一次的音频内容，buffer的时长也是包含上一次的时长
        // 本次持续时长为本次总时长减去上一次播放的持续时长（已播放时长+程序运行的延迟时间）
        let thisTimeDuration = buffer.duration - offsetDuration
        debug('本次播放可以持续时间thisTimeDuration:' + thisTimeDuration)

        audioBufferSourceNode.start(0, offsetDuration, thisTimeDuration)
        await delay(thisTimeDuration * 4 / 5 * 1000)
        scheduleBuffers()
      }
    }

    var PI = Math.PI
    var canvas = document.getElementById('canvas')
    var ctx = canvas.getContext('2d')
    var cwidth = canvas.width
    var cheight = canvas.height
    var cr = 150// 环形半径
    var minHeight = 2
    var meterWidth = 5
    var meterNum = 180// 设置方块的数量，考虑到闭环的关系
    var gradient = ctx.createLinearGradient(0, -cr, 0, -cwidth / 2)
    gradient.addColorStop(0, '#0f0')
    gradient.addColorStop(0.5, '#ff0')
    gradient.addColorStop(1, '#f00')
    ctx.fillStyle = gradient

    function render () {
      var array = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(array)

      var step = Math.round(array.length / meterNum)
      ctx.clearRect(0, 0, cwidth, cheight)
      ctx.save()
      // 移动中心点到圆心
      ctx.translate(cwidth / 2, cheight / 2)
      for (var i = 0; i < meterNum; i++) {
      // ctx.save();
        var value = array[i * step]
        var meterHeight = value * (cheight / 2 - cr) / 256 || minHeight
        // 根据圆心为中心点旋转
        ctx.rotate(2 * PI / meterNum)
        ctx.fillRect(-meterWidth / 2, -cr - meterHeight, meterWidth, meterHeight)
      // ctx.restore();
      }
      ctx.restore()
      requestAnimationFrame(render)
    }
  // render()
  }

  function delay (time) {
    return new Promise(resolve => setTimeout(resolve, time))
  }

  function concat (resultConstructor, ...arrays) {
    let totalLength = 0
    for (let arr of arrays) {
      totalLength += arr.length
    }
    let result = new resultConstructor(totalLength)
    let offset = 0
    for (let arr of arrays) {
      result.set(arr, offset)
      offset += arr.length
    }
    return result
  }

  function debug (msg) {
    if (console && console.log) {
      if (typeof msg === 'string') {
        var d = new Date()
        console.log(d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.getHours() + ':' + d.getMinutes() + ':' + d.getSeconds() + ':' + d.getMilliseconds() + ' ' + msg)
      } else {
        console.log(msg)
      }
    }
  }
})()
