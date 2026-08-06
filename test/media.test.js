import test from "node:test";
import assert from "node:assert/strict";
import { classifyUrl, formatDuration, inferM4sTrack, inferTencentM3u8, inferYouTubeTrack, isTencentIndexedSegment, isTencentSvpSegment, mediaRootKey, parseFlvMetadata, parseM3u8, segmentEndSeconds, streamGroupKey, tencentVideoGroupKey, youkuPlaylistGroupKey, youkuVideoId } from "../src/core/media.js";

test("classifies media using URL and content type", () => {
  assert.equal(classifyUrl("https://cdn.test/video.MP4?token=x"), "mp4");
  assert.equal(classifyUrl("https://v26-web.douyinvod.com/media-video-avc1/?mime_type=video_mp4"), "mp4");
  assert.equal(classifyUrl("https://www.douyin.com/aweme/v1/play/?video_id=test"), "mp4");
  assert.equal(classifyUrl("https://cdn.test/play?id=1", "application/vnd.apple.mpegurl"), "m3u8");
  assert.equal(classifyUrl("https://cdn.test/live/03_video.ts?token=x"), "stream");
  assert.equal(classifyUrl("https://live.test/channel.flv?token=x"), "flv");
  assert.equal(classifyUrl("https://xy.bilivideo.com/video.m4s?deadline=1", "video/mp4"), "m4s");
  assert.equal(classifyUrl("https://rr1.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4"), "youtube");
  assert.equal(classifyUrl("https://cdn.test/image.jpg", "image/jpeg"), null);
});

test("distinguishes YouTube progressive and DASH tracks", () => {
  assert.equal(inferYouTubeTrack("https://rr.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4"), "muxed");
  assert.equal(inferYouTubeTrack("https://rr.googlevideo.com/videoplayback?itag=137&mime=video%2Fmp4"), "video");
  assert.equal(inferYouTubeTrack("https://rr.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4"), "audio");
});

test("distinguishes Bilibili M4S video and audio tracks", () => {
  assert.equal(inferM4sTrack("https://xy.bilivideo.com/video.m4s?token=x"), "video");
  assert.equal(inferM4sTrack("https://xy.bilivideo.com/audio.m4s?token=x"), "audio");
  assert.equal(inferM4sTrack("https://xy.bilivideo.com/30280.m4s"), "audio");
});

test("reads duration from FLV onMetaData script tag", () => {
  const name = Buffer.from("onMetaData");
  const key = Buffer.from("duration");
  const data = Buffer.alloc(1 + 2 + name.length + 1 + 4 + 2 + key.length + 1 + 8 + 3);
  let p = 0;
  data[p++] = 2; data.writeUInt16BE(name.length, p); p += 2; name.copy(data, p); p += name.length;
  data[p++] = 8; data.writeUInt32BE(1, p); p += 4;
  data.writeUInt16BE(key.length, p); p += 2; key.copy(data, p); p += key.length;
  data[p++] = 0; data.writeDoubleBE(125.5, p); p += 8;
  data[p++] = 0; data[p++] = 0; data[p++] = 9;
  const flv = Buffer.alloc(9 + 4 + 11 + data.length + 4);
  flv.write("FLV", 0); flv[3] = 1; flv[4] = 5; flv.writeUInt32BE(9, 5);
  const tag = 13; flv[tag] = 18; flv[tag + 1] = data.length >> 16; flv[tag + 2] = data.length >> 8; flv[tag + 3] = data.length;
  data.copy(flv, tag + 11);
  const arrayBuffer = flv.buffer.slice(flv.byteOffset, flv.byteOffset + flv.byteLength);
  assert.equal(parseFlvMetadata(arrayBuffer).duration, 125.5);
});

test("groups signed segments and reads Tencent timeline", () => {
  const a = "https://cdn.test/live/03_video.ts?index=3&start=36000&end=48000&token=a";
  const b = "https://cdn.test/live/04_video.ts?index=4&start=48000&end=62000&token=b";
  assert.equal(streamGroupKey(a), streamGroupKey(b));
  assert.equal(segmentEndSeconds(b), 62);
});

test("groups a manifest and segments by host plus first path segment", () => {
  assert.equal(mediaRootKey("https://cdn.test/c1/video/master.m3u8?token=1"), "media-root:https://cdn.test/c1");
  assert.equal(mediaRootKey("https://cdn.test/c1/fragments/001.m4s?token=2"), "media-root:https://cdn.test/c1");
  assert.notEqual(mediaRootKey("https://cdn.test/c2/001.ts"), "media-root:https://cdn.test/c1");
});

test("derives Tencent SVP HLS playlist from a signed TS segment", () => {
  const segment = "https://ltscsysw.gtimg.com/signed/svp_50112/path/video.f322062.1.ts?index=5&start=42875&end=52666&brs=2942764&bre=3656599&ver=4&token=secret";
  assert.equal(inferTencentM3u8(segment), "https://ltscsysw.gtimg.com/signed/svp_50112/path/video.f322062.ts.m3u8?ver=4");
  assert.equal(isTencentSvpSegment(segment), true);
  assert.equal(inferTencentM3u8("https://other.test/video.f322062.1.ts?ver=4"), null);
  assert.equal(isTencentSvpSegment("https://other.test/video.f322062.1.ts?ver=4"), false);
  const qqSegment = "https://ltscsy.qq.com/B_signed/svp_50112/path/video.f322062.3.ts?index=3&ver=4&token=secret";
  assert.equal(inferTencentM3u8(qqSegment), "https://ltscsy.qq.com/B_signed/svp_50112/path/video.f322062.ts.m3u8?ver=4");
  assert.equal(isTencentSvpSegment(qqSegment), true);
  const alternateCdn = "https://cdn.example/video.f322062.5.ts?index=5&start=42875&ver=4&token=secret";
  assert.equal(inferTencentM3u8(alternateCdn), null);
  assert.equal(inferTencentM3u8(alternateCdn, true), "https://cdn.example/video.f322062.ts.m3u8?ver=4");
  assert.equal(isTencentIndexedSegment(alternateCdn), true);
  const numberedLine = "https://cdn.example/B_signed/svp_50112/path/016_gzc_asset.f322062.1.ts?index=1&start=0&ver=4&token=secret";
  assert.equal(inferTencentM3u8(numberedLine, true), "https://cdn.example/B_signed/svp_50112/path/gzc_asset.f322062.ts.m3u8?ver=4");
});

test("groups Tencent media addresses by host and outer signed path", () => {
  const a = "https://ltsbdy.gtimg.com/B_same/svp_50112/a/video.f1.ts.m3u8?ver=4";
  const b = "https://ltsbdy.gtimg.com/B_same/svp_50112/b/video.f2.ts.m3u8?ver=4";
  assert.equal(tencentVideoGroupKey(a), tencentVideoGroupKey(b));
  assert.notEqual(tencentVideoGroupKey(a), tencentVideoGroupKey("https://ltsbdy.gtimg.com/B_other/svp_50112/a/video.m3u8"));
  assert.equal(tencentVideoGroupKey("https://future-cdn.example/B_same/path/video.m3u8", true), "tencent:https://future-cdn.example/B_same");
  const proxyA = "https://hash.v.smtcdns.com/moviets.tc.qq.com/proxy-token/B_same/svp_50112/path/016_gzc_video.f1.ts.m3u8?ver=4";
  const proxyB = "https://hash.v.smtcdns.com/moviets.tc.qq.com/proxy-token/B_same/svp_50112/path/015_gzc_video.f1.ts.m3u8?ver=4";
  assert.equal(tencentVideoGroupKey(proxyA, true), tencentVideoGroupKey(proxyB, true));
});

test("sums media playlist duration", () => {
  const parsed = parseM3u8("#EXTM3U\n#EXTINF:4.25,\na.ts\n#EXTINF:5.75,\nb.ts\n#EXT-X-ENDLIST", "https://cdn.test/master.m3u8");
  assert.equal(parsed.duration, 10);
  assert.equal(parsed.hasEndList, true);
  assert.equal(parsed.isMediaPlaylist, true);
  assert.deepEqual(parsed.variants, []);
  assert.deepEqual(parsed.segments, ["https://cdn.test/a.ts", "https://cdn.test/b.ts"]);
});

test("identifies an HLS media playlist without ENDLIST as live", () => {
  const parsed = parseM3u8("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI=\"init.m4s\"\n#EXTINF:1.00,\n518629601.m4s", "https://live.test/index.m3u8");
  assert.equal(parsed.duration, 1);
  assert.equal(parsed.hasEndList, false);
  assert.equal(parsed.isMediaPlaylist, true);
  assert.deepEqual(parsed.segments, ["https://live.test/init.m4s", "https://live.test/518629601.m4s"]);
});

test("resolves master playlist variants", () => {
  const parsed = parseM3u8("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720/index.m3u8", "https://cdn.test/master.m3u8");
  assert.deepEqual(parsed.variants, ["https://cdn.test/720/index.m3u8"]);
});

test("resolves separate HLS audio and video playlists as one master", () => {
  const parsed = parseM3u8('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/a.m3u8",GROUP-ID="aac"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aac"\nvideo/v.m3u8', "https://pl.test/playlist/master.m3u8");
  assert.deepEqual(parsed.variants, ["https://pl.test/playlist/audio/a.m3u8", "https://pl.test/playlist/video/v.m3u8"]);
  assert.equal(parsed.isMediaPlaylist, false);
});

test("groups Youku master, audio and video playlists by vid", () => {
  const master = "https://pl-ali.youku.com/playlist/m3u8?vid=XNTk3MzA5NzgzMg%3D%3D&type=cmfv4hd&ups_key=a";
  const audio = "http://valipl.example/track/audio.m3u8?vid=XNTk3MzA5NzgzMg%3D%3D&vkey=b";
  const video = "http://other.example/track/video.m3u8?vid=XNTk3MzA5NzgzMg%3D%3D&vkey=c";
  assert.equal(youkuPlaylistGroupKey(master), youkuPlaylistGroupKey(audio));
  assert.equal(youkuPlaylistGroupKey(master), youkuPlaylistGroupKey(video));
  assert.equal(youkuVideoId(master), "XNTk3MzA5NzgzMg");
  assert.equal(youkuVideoId("https://cdn.test/v.mp4?vid=XNTk3MzA5NzgzMg"), "XNTk3MzA5NzgzMg");
});

test("formats duration", () => {
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(3661), "1:01:01");
  assert.equal(formatDuration(null), "未知");
});
