/**
 * 引擎 life 模块的插件侧桥接（类型再导出 + 本地适配）。
 * 引擎导出了 store 函数，这里汇总供 autonomy/tools 两处统一引用。
 */
export {
  getResident, listResidents, createResident, deleteResident,
  createChannel, listChannels, getChannel,
  appendMessage, readMessages, readBookmark, writeBookmark,
  withEngine,
} from 'hippo-mind'

/** 记忆召回（life-tools 里的同名函数提出来共用）。 */
export { recallMemories } from './life-tools.ts'
