/**
 * Audio core: everything the app does with sound files, for the browser and
 * the desktop build alike. Functions that decode take an AudioBackend
 * (createBrowserAudioBackend() here, the Rust backend on the desktop).
 *
 * Typical flows (see the tests in tests/audio/flows.test.ts):
 *
 * - Copy an MP3 with a small tag: measureTags/tagBytes tell how big the old
 *   tags are; replaceTags(source, buildSmallId3({...})) writes the copy.
 * - Album loudness, lossless: backend.analyze() every track, then
 *   stepsForTarget(albumLoudness(analyses), -18) and applyGain(source,
 *   await scanMp3(source), steps, { tag }) with the same steps for every track.
 * - Split a long MP3: analyze, findPauses, planSplits (or cutsFromChapters
 *   when the file has chapters), scanMp3, cutMp3 with tagFor.
 * - Other formats: convertToMp3(backend, source, opts) makes an MP3 whose
 *   timeline equals the source's, so the same analysis splits it. For long
 *   files, convertToMp3Parts(backend, source, cutTimes, opts) converts and
 *   splits in one go, encoding several parts at once (much faster).
 */

export { fileSource, bufferSource, readChunks, readRange, blobOfRange, CHUNK_SIZE } from './source';
export { AudioError, audioErrorMessage, isAbortError, type AudioErrorCode, type AudioErrorDetails } from './errors';
export { sniffContainer, kindFromName, type ContainerKind } from './formats';
export {
  measureTags,
  tagBytes,
  readTags,
  replaceTags,
  buildSmallId3,
  chaptersFromId3,
  parseId3v2,
  parseId3v1,
  type BasicTags,
  type Id3v2Tag,
  type SmallTags,
  type TagLayout,
  type TagReadResult,
} from './id3';
export {
  scanMp3,
  probeMp3,
  mp3DurationSec,
  mp3DurationOf,
  checkMp3,
  isDamagedMp3,
  looksJoined,
  rebuildReason,
  decodedTooShort,
  frameAtTime,
  timeOfFrame,
  type Mp3Index,
  type Mp3Check,
  type Mp3Rebuild,
  type ScanOptions,
  type FrameHeader,
} from './mp3frames';
export { cutMp3, cutMp3Parts, snapCuts, buildXingFrame, type CutOptions, type XingFrameParams, type XingFrameInfo, type LameTagInfo } from './mp3cut';
export { applyGain, stepsForTarget, GAIN_STEP_DB, type GainOptions } from './mp3gain';
export {
  PowerEnvelope,
  integratedLoudness,
  momentaryDb,
  powerToLufs,
  playbackLufs,
  albumLoudness,
  planAlbumGain,
  levelTarget,
  LIMITER_CEILING_DB,
  isClipped,
  ClipCounter,
  MONO_PLAYBACK_OFFSET_DB,
  TARGET_LUFS,
  MAX_BOOST_DB,
  QUIET_SHORTFALL_DB,
  type AlbumGain,
  type AlbumGainInput,
} from './loudness';
export {
  findPauses,
  levelStats,
  planSplits,
  cutsFromChapters,
  snapCutsToPauses,
  type Pause,
  type PauseOptions,
  type LevelStats,
  type Cut,
  type CutKind,
  type SplitPart,
  type SplitPlan,
  type ChapterMark,
  type PlanOptions,
  type ChapterSplitOptions,
  type TrackCut,
  type SnapOptions,
} from './silence';
export { Resampler, resampleBuffer, type ResamplerOptions, type ResampleQuality } from './resample';
export { ArrayPcmReader, withSampleRate, downmix, analyzePcm, readAllPcm } from './pcm';
export { encodeWav16 } from './wav';
export { openAudio, analyzeAudio, type DecodeEnv, type OpenedAudio, type OpenAudioOptions, type AnalyzeAudioOptions } from './decode';
export { analyzeMp3, Mp3PcmReader } from './mp3decode';
export { createBrowserAudioBackend, MAX_IN_MEMORY_SEC, MAX_IN_MEMORY_FILE_BYTES, type BrowserAudioBackendOptions, type InMemoryAudio, type WorkerLike } from './browserBackend';
export {
  encodeFromReader,
  convertToMp3,
  convertToMp3Parts,
  loadMp3Encoder,
  Mp3StreamEncoder,
  PeakLimiter,
  effectiveBitrate,
  MP3_SAMPLE_RATE,
  LAME_ENCODER_DELAY,
  type EncodeOptions,
  type ConvertOptions,
  type ConvertPartsOptions,
  type Mp3EncoderOptions,
} from './encode';
