// @ts-check

/***
 * The FLV demuxer is from flv.js
 *
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var navigator = typeof navigator === 'object' && navigator || { userAgent: 'chrome' }

// import FLVDemuxer from 'flv.js/src/demux/flv-demuxer.js';
// ..import Log from '../utils/logger.js';
const Log = {
  e: console.error.bind(console),
  w: console.warn.bind(console),
  i: console.log.bind(console),
  v: console.log.bind(console)
}

// ....import {IllegalStateException} from '../utils/exception.js';
class IllegalStateException extends Error { }

// ..import DemuxErrors from './demux-errors.js';
const DemuxErrors = {
  OK: 'OK',
  FORMAT_ERROR: 'FormatError',
  FORMAT_UNSUPPORTED: 'FormatUnsupported',
  CODEC_UNSUPPORTED: 'CodecUnsupported'
}

// ..import MediaInfo from '../core/media-info.js';
class MediaInfo {
  constructor () {
    this.mimeType = null
    this.duration = null

    this.hasAudio = null
    this.hasVideo = null
    this.audioCodec = null
    this.videoCodec = null
    this.audioDataRate = null
    this.videoDataRate = null

    this.audioSampleRate = null
    this.audioChannelCount = null

    this.width = null
    this.height = null
    this.fps = null
    this.profile = null
    this.level = null
    this.chromaFormat = null
    this.sarNum = null
    this.sarDen = null

    this.metadata = null
    this.segments = null // MediaInfo[]
    this.segmentCount = null
    this.hasKeyframesIndex = null
    this.keyframesIndex = null
  }

  isComplete () {
    let audioInfoComplete = (this.hasAudio === false) ||
            (this.hasAudio === true &&
                this.audioCodec != null &&
                this.audioSampleRate != null &&
                this.audioChannelCount != null)

    let videoInfoComplete = (this.hasVideo === false) ||
            (this.hasVideo === true &&
                this.videoCodec != null &&
                this.width != null &&
                this.height != null &&
                this.fps != null &&
                this.profile != null &&
                this.level != null &&
                this.chromaFormat != null &&
                this.sarNum != null &&
                this.sarDen != null)

    // keyframesIndex may not be present
    return this.mimeType != null &&
            this.duration != null &&
            this.metadata != null &&
            this.hasKeyframesIndex != null &&
            audioInfoComplete &&
            videoInfoComplete
  }

  isSeekable () {
    return this.hasKeyframesIndex === true
  }

  getNearestKeyframe (milliseconds) {
    if (this.keyframesIndex == null) {
      return null
    }

    let table = this.keyframesIndex
    let keyframeIdx = this._search(table.times, milliseconds)

    return {
      index: keyframeIdx,
      milliseconds: table.times[keyframeIdx],
      fileposition: table.filepositions[keyframeIdx]
    }
  }

  _search (list, value) {
    let idx = 0

    let last = list.length - 1
    let mid = 0
    let lbound = 0
    let ubound = last

    if (value < list[0]) {
      idx = 0
      lbound = ubound + 1 // skip search
    }

    while (lbound <= ubound) {
      mid = lbound + Math.floor((ubound - lbound) / 2)
      if (mid === last || (value >= list[mid] && value < list[mid + 1])) {
        idx = mid
        break
      } else if (list[mid] < value) {
        lbound = mid + 1
      } else {
        ubound = mid - 1
      }
    }

    return idx
  }
}

function ReadBig32 (array, index) {
  return ((array[index] << 24) |
        (array[index + 1] << 16) |
        (array[index + 2] << 8) |
        (array[index + 3]))
}

class FLVDemuxer {
  /**
     * Create a new FLV demuxer
     * @param {Object} probeData
     * @param {boolean} probeData.match
     * @param {number} probeData.consumed
     * @param {number} probeData.dataOffset
     * @param {boolean} probeData.hasAudioTrack
     * @param {boolean} probeData.hasVideoTrack
     */
  constructor (probeData) {
    this.TAG = 'FLVDemuxer'

    this._onError = null
    this._onMediaInfo = null
    this._onTrackMetadata = null
    this._onDataAvailable = null

    this._dataOffset = probeData.dataOffset
    this._firstParse = true
    this._dispatch = false

    this._hasAudio = probeData.hasAudioTrack
    this._hasVideo = probeData.hasVideoTrack

    this._hasAudioFlagOverrided = false
    this._hasVideoFlagOverrided = false

    this._audioInitialMetadataDispatched = false
    this._videoInitialMetadataDispatched = false

    this._mediaInfo = new MediaInfo()
    this._mediaInfo.hasAudio = this._hasAudio
    this._mediaInfo.hasVideo = this._hasVideo
    this._metadata = null
    this._audioMetadata = null
    this._videoMetadata = null

    this._naluLengthSize = 4
    this._timestampBase = 0 // int32, in milliseconds
    this._timescale = 1000
    this._duration = 0 // int32, in milliseconds
    this._durationOverrided = false
    this._referenceFrameRate = {
      fixed: true,
      fps: 23.976,
      fps_num: 23976,
      fps_den: 1000
    }

    this._flvSoundRateTable = [5500, 11025, 22050, 44100, 48000]

    this._mpegSamplingRates = [
      96000, 88200, 64000, 48000, 44100, 32000,
      24000, 22050, 16000, 12000, 11025, 8000, 7350
    ]

    this._mpegAudioV10SampleRateTable = [44100, 48000, 32000, 0]
    this._mpegAudioV20SampleRateTable = [22050, 24000, 16000, 0]
    this._mpegAudioV25SampleRateTable = [11025, 12000, 8000, 0]

    this._mpegAudioL1BitRateTable = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1]
    this._mpegAudioL2BitRateTable = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1]
    this._mpegAudioL3BitRateTable = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1]

    this._videoTrack = { type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0 }
    this._audioTrack = { type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0 }
    this._littleEndian = (function () {
      let buf = new ArrayBuffer(2);
      (new DataView(buf)).setInt16(0, 256, true) // little-endian write
      return (new Int16Array(buf))[0] === 256 // platform-spec read, if equal then LE
    })()
  }

  destroy () {
    this._mediaInfo = null
    this._metadata = null
    this._audioMetadata = null
    this._videoMetadata = null
    this._videoTrack = null
    this._audioTrack = null

    this._onError = null
    this._onMediaInfo = null
    this._onTrackMetadata = null
    this._onDataAvailable = null
  }

  /**
     * Probe the flv data
     * @param {ArrayBuffer} buffer
     * @returns {Object} - probeData to be feed into constructor
     */
  static probe (buffer) {
    let data = new Uint8Array(buffer)
    let mismatch = { match: false }

    // flv header的前三个字节为文件标志“FLV”，第四个字节为版本号
    if (data[0] !== 0x46 || data[1] !== 0x4C || data[2] !== 0x56 || data[3] !== 0x01) {
      return mismatch
    }

    // 第四个字节，前五位保留，第六位表示是否存在音频tag，第七位保留必须为0，第八位表示是否存在视频tag
    let hasAudio = ((data[4] & 4) >>> 2) !== 0
    let hasVideo = (data[4] & 1) !== 0

    // ReadBig32(array, index) 大端 32 位法读数据，将二进制数组的第 1 个元素向左偏移 24 位，第 2 个元素向左偏移 16 位，第 3 个元素向左偏移 8 位，第 4 个元素不偏移，最后一起做或运算
    let offset = ReadBig32(data, 5)

    if (offset < 9) {
      return mismatch
    }

    return {
      match: true,
      consumed: offset,
      dataOffset: offset,
      hasAudioTrack: hasAudio,
      hasVideoTrack: hasVideo
    }
  }

  bindDataSource (loader) {
    loader.onDataArrival = this.parseChunks.bind(this)
    return this
  }

  // prototype: function(type: string, metadata: any): void
  get onTrackMetadata () {
    return this._onTrackMetadata
  }

  set onTrackMetadata (callback) {
    this._onTrackMetadata = callback
  }

  // prototype: function(mediaInfo: MediaInfo): void
  get onMediaInfo () {
    return this._onMediaInfo
  }

  set onMediaInfo (callback) {
    this._onMediaInfo = callback
  }

  // prototype: function(type: number, info: string): void
  get onError () {
    return this._onError
  }

  set onError (callback) {
    this._onError = callback
  }

  // prototype: function(videoTrack: any, audioTrack: any): void
  get onDataAvailable () {
    return this._onDataAvailable
  }

  set onDataAvailable (callback) {
    this._onDataAvailable = callback
  }

  // timestamp base for output samples, must be in milliseconds
  get timestampBase () {
    return this._timestampBase
  }

  set timestampBase (base) {
    this._timestampBase = base
  }

  get overridedDuration () {
    return this._duration
  }

  // Force-override media duration. Must be in milliseconds, int32
  set overridedDuration (duration) {
    this._durationOverrided = true
    this._duration = duration
    this._mediaInfo.duration = duration
  }

  // Force-override audio track present flag, boolean
  set overridedHasAudio (hasAudio) {
    this._hasAudioFlagOverrided = true
    this._hasAudio = hasAudio
    this._mediaInfo.hasAudio = hasAudio
  }

  // Force-override video track present flag, boolean
  set overridedHasVideo (hasVideo) {
    this._hasVideoFlagOverrided = true
    this._hasVideo = hasVideo
    this._mediaInfo.hasVideo = hasVideo
  }

  _isInitialMetadataDispatched () {
    if (this._hasAudio) { // audio only
      return this._audioInitialMetadataDispatched
    }
    return false
  }

  // function parseChunks(chunk: ArrayBuffer, byteStart: number): number;
  parseChunks (chunk, byteStart) {
    if (!this._onError || !this._onMediaInfo || !this._onTrackMetadata || !this._onDataAvailable) {
      throw new IllegalStateException('Flv: onError & onMediaInfo & onTrackMetadata & onDataAvailable callback must be specified')
    }

    // qli5: fix nonzero byteStart
    // let offset = 0;
    let offset = byteStart || 0
    let le = this._littleEndian

    if (byteStart === 0) { // buffer with FLV header
      if (chunk.byteLength > 13) {
        let probeData = FLVDemuxer.probe(chunk)
        offset = probeData.dataOffset
      } else {
        return 0
      }
    }

    if (this._firstParse) { // handle PreviousTagSize0 before Tag1
      this._firstParse = false
      if (offset !== this._dataOffset) {
        Log.w(this.TAG, 'First time parsing but chunk byteStart invalid!')
      }

      let v = new DataView(chunk, offset)
      let prevTagSize0 = v.getUint32(0, !le)
      if (prevTagSize0 !== 0) {
        Log.w(this.TAG, 'PrevTagSize0 !== 0 !!!')
      }
      offset += 4
    }

    // 对每个flv tag解析
    while (offset < chunk.byteLength) {
      this._dispatch = true

      let v = new DataView(chunk, offset)

      // tag header has 11 bytes, previous tag size is 4 bytes.
      if (offset + 11 + 4 > chunk.byteLength) {
        // tag data not enough for parsing an flv tag
        break
      }

      let tagType = v.getUint8(0)
      let dataSize = v.getUint32(0, !le) & 0x00FFFFFF

      if (offset + 11 + dataSize + 4 > chunk.byteLength) {
        // data not enough for parsing actual data body
        break
      }

      if (tagType !== 8 && tagType !== 9 && tagType !== 18) {
        Log.w(this.TAG, `Unsupported tag type ${tagType}, skipped`)
        // consume the whole tag (skip it)
        offset += 11 + dataSize + 4
        continue
      }

      let ts2 = v.getUint8(4)
      let ts1 = v.getUint8(5)
      let ts0 = v.getUint8(6)
      let ts3 = v.getUint8(7)

      let timestamp = ts0 | (ts1 << 8) | (ts2 << 16) | (ts3 << 24)

      let streamId = v.getUint32(7, !le) & 0x00FFFFFF
      if (streamId !== 0) {
        Log.w(this.TAG, 'Meet tag which has StreamID != 0!')
      }
      // tag header为11字节，此作用为取tag data部分
      let dataOffset = offset + 11
      switch (tagType) {
        case 8: // Audio
          this._parseAudioData(chunk, dataOffset, dataSize, timestamp)
          break
        case 9: // Video
          break
        case 18: // ScriptDataObject
          break
      }

      let prevTagSize = v.getUint32(11 + dataSize, !le)
      if (prevTagSize !== 11 + dataSize) {
        Log.w(this.TAG, `Invalid PrevTagSize ${prevTagSize}`)
      }

      offset += 11 + dataSize + 4 // tagBody + dataSize + prevTagSize
    }

    // dispatch parsed frames to consumer (typically, the remuxer)
    if (this._isInitialMetadataDispatched()) {
      if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
        console.log('_onDataAvailable1')
        this._onDataAvailable(this._audioTrack, this._videoTrack)
      }
    }

    return offset // consumed bytes, just equals latest offset index
  }

  _parseAudioData (arrayBuffer, dataOffset, dataSize, tagTimestamp) {
    if (dataSize <= 1) {
      Log.w(this.TAG, 'Flv: Invalid audio packet, missing SoundData payload!')
      return
    }

    if (this._hasAudioFlagOverrided === true && this._hasAudio === false) {
      // If hasAudio: false indicated explicitly in MediaDataSource,
      // Ignore all the audio packets
      return
    }

    let le = this._littleEndian
    let v = new DataView(arrayBuffer, dataOffset, dataSize)

    // 音频Tag data开始的
    // 第1个字节包含了音频数据的参数信息(
    // 1-4位：音频编码类型，
    // 5-6位：采样率，
    // 第7位：精度，
    // 第8位：音频类型)，
    // 从第2个字节开始为音频流数据
    // 取tag data的第一个字节，从偏移位0开始取8位
    let soundSpec = v.getUint8(0)

    // 取前4位，代表音频类型
    let soundFormat = soundSpec >>> 4
    if (soundFormat !== 2 && soundFormat !== 10) { // MP3 or AAC
      this._onError(DemuxErrors.CODEC_UNSUPPORTED, 'Flv: Unsupported audio codec idx: ' + soundFormat)
      return
    }

    let soundRate = 0
    // 12的二进制为：00001100
    // 因为1与0、1做与运算，都是等于对方的值，0与0、1做与运算都是0，所以想获取哪几位的值，就保留那几位为1，其他位为0，然后与目标值做与运算
    // 取第5、6位，采样率
    // 采样率值对应关系：
    // 0 => 5.5kHz
    // 1 => 11kHz
    // 2 => 22kHz
    // 3 => 44kHz
    // 4 => 48kHz

    // 采样率
    let soundRateIndex = (soundSpec & 12) >>> 2
    if (soundRateIndex >= 0 && soundRateIndex <= 4) {
      // 获取采样率的值
      soundRate = this._flvSoundRateTable[soundRateIndex]
    } else {
      this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid audio sample rate idx: ' + soundRateIndex)
      return
    }

    // 获取第七位音频采样精度，0：8bit  1: 16bit
    // 采样精度越高，声音还原度越好
    let soundSize = (soundSpec & 2) >>> 1 // unused
    // 获取第八位音频类型， 0：sndMono  1:sndStereo
    let soundType = (soundSpec & 1)

    // metadata一般为flv的script data部分，一般只有一个
    // meta
    let meta = this._audioMetadata
    let track = this._audioTrack

    if (!meta) {
      if (this._hasAudio === false && this._hasAudioFlagOverrided === false) {
        this._hasAudio = true
        this._mediaInfo.hasAudio = true
      }

      // initial metadata
      meta = this._audioMetadata = {}
      meta.type = 'audio'
      meta.id = track.id
      // 用于音视频同步的时间尺度
      meta.timescale = this._timescale
      meta.duration = this._duration
      meta.audioSampleRate = soundRate
      meta.channelCount = (soundType === 0 ? 1 : 2)
    }

    if (soundFormat === 10) { // AAC
      // 解析aac获得音频的一些配置信息，比如Audio Object Type，用来对aac音频添加adts头部用audioContext decode.
      let aacData = this._parseAACAudioData(arrayBuffer, dataOffset + 1, dataSize - 1)
      if (aacData == undefined) {
        return
      }
      if (aacData.packetType === 0) { // AAC sequence header (AudioSpecificConfig)
        if (meta.config) {
          Log.w(this.TAG, 'Found another AudioSpecificConfig!')
        }
        let misc = aacData.data
        meta.audioSampleRate = misc.samplingRate
        meta.channelCount = misc.channelCount
        meta.codec = misc.codec
        meta.originalCodec = misc.originalCodec
        meta.config = misc.config
        // added by qli5
        meta.configRaw = misc.configRaw
        // added by Xmader
        meta.audioObjectType = misc.audioObjectType
        meta.samplingFrequencyIndex = misc.samplingIndex
        meta.channelConfig = misc.channelCount
        // The decode result of Fan aac sample is 1024 PCM samples
        meta.refSampleDuration = 1024 / meta.audioSampleRate * meta.timescale
        Log.v(this.TAG, 'Parsed AudioSpecificConfig')

        if (this._isInitialMetadataDispatched()) {
          // Non-initial metadata, force dispatch (or flush) parsed frames to remuxer
          if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
            console.log('_onDataAvailable2')
            this._onDataAvailable(this._audioTrack, this._videoTrack)
          }
        } else {
          this._audioInitialMetadataDispatched = true
        }
        // then notify new metadata
        this._dispatch = false
        // metadata中的信息提供给外部封装aac的adts头部
        this._onTrackMetadata('audio', meta)

        let mi = this._mediaInfo
        mi.audioCodec = meta.originalCodec
        mi.audioSampleRate = meta.audioSampleRate
        mi.audioChannelCount = meta.channelCount
        if (mi.hasVideo) {
          if (mi.videoCodec != null) {
            mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"'
          }
        } else {
          mi.mimeType = 'video/x-flv; codecs="' + mi.audioCodec + '"'
        }
        if (mi.isComplete()) {
          this._onMediaInfo(mi)
        }
      } else if (aacData.packetType === 1) { // AAC raw frame data
        let dts = this._timestampBase + tagTimestamp
        // DTS（Decoding Time Stamp）：即解码时间戳，这个时间戳的意义在于告诉播放器该在什么时候解码这一帧的数据。
        // PTS（Presentation Time Stamp）：即显示时间戳，这个时间戳用来告诉播放器该在什么时候显示这一帧的数据。
        // 用于音视频的对齐和播放
        let aacSample = { unit: aacData.data, length: aacData.data.byteLength, dts: dts, pts: dts }

        track.samples.push(aacSample)
        track.length += aacData.data.length
      } else {
        Log.e(this.TAG, `Flv: Unsupported AAC data type ${aacData.packetType}`)
      }
    } else if (soundFormat === 2) { // MP3
      Log.e(this.TAG, 'Flv: Unsupported audio codec idx: MP3')
    }
  }

  _parseAACAudioData (arrayBuffer, dataOffset, dataSize) {
    if (dataSize <= 1) {
      Log.w(this.TAG, 'Flv: Invalid AAC packet, missing AACPacketType or/and Data!')
      return
    }

    let result = {}
    let array = new Uint8Array(arrayBuffer, dataOffset, dataSize)

    // 0: AAC sequence header
    // AAC中用AudioSpecificConfig结构体来表示AAC sequence header.
    // 1: AAC raw
    // 一般Sequence Header为第一个Audio Tag，并且全文件只出现一次
    result.packetType = array[0]

    if (array[0] === 0) {
      result.data = this._parseAACAudioSpecificConfig(arrayBuffer, dataOffset + 1, dataSize - 1)
    } else {
      result.data = array.subarray(1)
    }

    return result
  }

  _parseAACAudioSpecificConfig (arrayBuffer, dataOffset, dataSize) {
    let array = new Uint8Array(arrayBuffer, dataOffset, dataSize)
    let config = null

    /* Audio Object Type:
           0: Null
           1: AAC Main
           2: AAC LC
           3: AAC SSR (Scalable Sample Rate)
           4: AAC LTP (Long Term Prediction)
           5: HE-AAC / SBR (Spectral Band Replication)
           6: AAC Scalable
        */

    let audioObjectType = 0
    let originalAudioObjectType = 0
    let audioExtensionObjectType = null
    let samplingIndex = 0
    let extensionSamplingIndex = null

    // 5 bits
    audioObjectType = originalAudioObjectType = array[0] >>> 3
    // 4 bits
    samplingIndex = ((array[0] & 0x07) << 1) | (array[1] >>> 7)
    if (samplingIndex < 0 || samplingIndex >= this._mpegSamplingRates.length) {
      this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: AAC invalid sampling frequency index!')
      return
    }

    let samplingFrequence = this._mpegSamplingRates[samplingIndex]

    // 4 bits
    let channelConfig = (array[1] & 0x78) >>> 3
    if (channelConfig < 0 || channelConfig >= 8) {
      this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: AAC invalid channel configuration')
      return
    }

    if (audioObjectType === 5) { // HE-AAC?
      // 4 bits
      extensionSamplingIndex = ((array[1] & 0x07) << 1) | (array[2] >>> 7)
      // 5 bits
      audioExtensionObjectType = (array[2] & 0x7C) >>> 2
    }

    // workarounds for various browsers
    let userAgent = navigator.userAgent.toLowerCase()

    if (userAgent.indexOf('firefox') !== -1) {
      // firefox: use SBR (HE-AAC) if freq less than 24kHz
      if (samplingIndex >= 6) {
        audioObjectType = 5
        config = new Array(4)
        extensionSamplingIndex = samplingIndex - 3
      } else { // use LC-AAC
        audioObjectType = 2
        config = new Array(2)
        extensionSamplingIndex = samplingIndex
      }
    } else if (userAgent.indexOf('android') !== -1) {
      // android: always use LC-AAC
      audioObjectType = 2
      config = new Array(2)
      extensionSamplingIndex = samplingIndex
    } else {
      // for other browsers, e.g. chrome...
      // Always use HE-AAC to make it easier to switch aac codec profile
      audioObjectType = 5
      extensionSamplingIndex = samplingIndex
      config = new Array(4)

      if (samplingIndex >= 6) {
        extensionSamplingIndex = samplingIndex - 3
      } else if (channelConfig === 1) { // Mono channel
        audioObjectType = 2
        config = new Array(2)
        extensionSamplingIndex = samplingIndex
      }
    }

    config[0] = audioObjectType << 3
    config[0] |= (samplingIndex & 0x0F) >>> 1
    config[1] = (samplingIndex & 0x0F) << 7
    config[1] |= (channelConfig & 0x0F) << 3
    if (audioObjectType === 5) {
      config[1] |= ((extensionSamplingIndex & 0x0F) >>> 1)
      config[2] = (extensionSamplingIndex & 0x01) << 7
      // extended audio object type: force to 2 (LC-AAC)
      config[2] |= (2 << 2)
      config[3] = 0
    }

    return {
      audioObjectType, // audio_object_type,        added by Xmader
      samplingIndex, // sampling_frequency_index, added by Xmader
      configRaw: array, // added by qli5
      config: config,
      samplingRate: samplingFrequence,
      channelCount: channelConfig, // channel_config
      codec: 'mp4a.40.' + audioObjectType,
      originalCodec: 'mp4a.40.' + originalAudioObjectType
    }
  }
}

// export { FLVDemuxer };
export default FLVDemuxer

// module.exports = FLVDemuxer
