# flv-audio-visualization
Flv audio visualization, parse AAC and use audioContext to realize visualization.

## Flv 直播流音频可视化实现

1.  利用fetch的reader渐进读取音视频的流内容
2.  借助flv-demuxer.js解析flv音频获取AAC ES流和ADTS头部信息
3.  利用audioContext实现音频频谱在canvas上的可视化

###  FLV 音频的连续播放

1. main-accumulate.js为ES流堆积方式的实现，会出现内存溢出，浏览器崩溃的问题，以及音频的卡顿感更强烈，``不推荐``这种方式，主要可以参考里面的scheduleBuffers函数，它是用来实现音频的拼接、延迟计算、播放点计算、播放时间计算等。

2. main.js为ES流分段播放实现（推荐方式），可以实现音频的连续播放，卡顿感几乎没有，有轻微的噪音。

#### 具体思路和讲解见我的博客：[FLV提取AAC音频单独播放并实现可视化的频谱](https://www.cnblogs.com/saysmy/p/10716886.html)

#### 有任何建议和意见欢迎提issue和PR一起讨论改进

本文flv-demuxer.js参考[flv2aac](https://github.com/Xmader/flv2aac)移除了视频相关的处理逻辑，只保留了[bilibili源码](https://github.com/bilibili/flv.js)的音频处理部分