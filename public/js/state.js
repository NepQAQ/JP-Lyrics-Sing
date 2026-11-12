// 全局状态（单一来源）。模块间通过 bus 事件通知变化。
//
// state.song      当前打开的歌曲（服务端 song.json 的副本）
// state.song.lines[i]._el  运行时挂载的 DOM 节点（发送给后端前会剔除下划线字段）
export const state = {
  settings: {},
  song: null,
  songs: [],            // 曲库摘要
  appMode: 'lyrics',    // lyrics | study
  editing: false,       // 编辑模式：点击单词选中而不是跳转
  activeIdx: -1,
};

/** 去掉运行时字段，得到可提交给后端的行对象 */
export function cleanLine(line) {
  const out = {};
  for (const [k, v] of Object.entries(line)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

export function lineById(id) {
  return state.song?.lines?.find(l => l.id === id) || null;
}

export function lineIndex(id) {
  return state.song?.lines?.findIndex(l => l.id === id) ?? -1;
}

/** 本曲中原文相同的其它行（副歌重复时同步编辑用） */
export function sameTextLines(line) {
  if (!state.song) return [];
  return state.song.lines.filter(l => l !== line && l.text === line.text);
}
