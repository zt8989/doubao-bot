// 跨平台行为：进程枚举/匹配、豆包安装路径探测、子进程 PATH 拼接。
// win32 分支用参数注入或环境变量开关，POSIX 上也能跑全套断言。
import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { commandMatchesBinary, processes } from "../src/cdp.mjs"
import { choose } from "../src/doubao.mjs"
import { envWithBins, EXTRA_BIN_DIRS } from "../src/util.mjs"

test("commandMatchesBinary：win32 命令行剥引号、归一斜杠和大小写再匹配", () => {
  const binary = "C:\\Users\\me\\AppData\\Local\\Doubao\\Application\\Doubao.exe"
  assert.equal(commandMatchesBinary(`"${binary}" --remote-debugging-port=1`, binary, "win32"), true)
  assert.equal(commandMatchesBinary(`"${binary}"`, binary, "win32"), true)
  assert.equal(commandMatchesBinary("c:/users/me/appdata/local/doubao/application/doubao.exe -x", binary, "win32"), true)
  assert.equal(commandMatchesBinary(`"C:\\other\\place\\Doubao.exe"`, binary, "win32"), false)
  assert.equal(commandMatchesBinary(`"C:\\Users\\me\\AppData\\Local\\Doubao\\Application\\DoubaoHelper.exe"`, binary, "win32"), false)
  assert.equal(commandMatchesBinary("/Applications/Doubao.app/Contents/MacOS/Doubao", "/Applications/Doubao.app/Contents/MacOS/Doubao", "darwin"), true)
  assert.equal(commandMatchesBinary("/Applications/Doubao.app/Contents/MacOS/Doubao --flag", "/Applications/Doubao.app/Contents/MacOS/Doubao", "darwin"), true)
  assert.equal(commandMatchesBinary("/Applications/Doubao.app/Contents/MacOS/Doubao --flag", "/Applications/Other.app/X", "darwin"), false)
})

test("processes：真的能枚举出当前测试进程自己", () => {
  const list = processes(process.execPath)
  assert.ok(Array.isArray(list))
  assert.ok(list.every((p) => Number.isInteger(p.pid) && typeof p.command === "string"))
  assert.ok(list.some((p) => p.pid === process.pid), `进程枚举应包含自身 PID ${process.pid}`)
})

test("choose：win32 按 LOCALAPPDATA 候选探测豆包，装了谁用谁", () => {
  const savedLocal = process.env.LOCALAPPDATA
  const savedApp = process.env.DOUBAO_WORK_APP
  process.env.DOUBAO_WORK_APP = ""
  const home = "C:\\Users\\me"
  const local = "C:\\Users\\me\\AppData\\Local"
  process.env.LOCALAPPDATA = local
  try {
    // 只装了豆包聊天版（本机实测布局 %LOCALAPPDATA%\Doubao\Application\Doubao.exe）
    const chatBin = path.win32.join(local, "Doubao", "Application", "Doubao.exe")
    const c1 = choose("win32", home, (p) => p === chatBin)
    assert.equal(c1.app.name, "豆包")
    assert.equal(c1.binary, chatBin)

    // 什么都没探测到：回豆包默认安装位，报错时能给出确切路径
    const c2 = choose("win32", home, () => false)
    assert.equal(c2.app.name, "豆包")
    assert.equal(c2.binary, path.win32.join(local, "Doubao", "Application", "Doubao.exe"))

    // DOUBAO_WORK_APP 显式指定优先
    process.env.DOUBAO_WORK_APP = "D:\\apps\\DoubaoWork.exe"
    const c3 = choose("win32", home, () => false)
    assert.equal(c3.binary, "D:\\apps\\DoubaoWork.exe")
    assert.equal(c3.app.name, "豆包工作")
  } finally {
    if (savedLocal === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = savedLocal
    if (savedApp === undefined) delete process.env.DOUBAO_WORK_APP
    else process.env.DOUBAO_WORK_APP = savedApp
  }
})

test("choose：darwin 仍走 /Applications", () => {
  const savedApp = process.env.DOUBAO_WORK_APP
  process.env.DOUBAO_WORK_APP = ""
  const mac = "/Applications/Doubao.app/Contents/MacOS/Doubao"
  try {
    const c = choose("darwin", "/Users/me", (p) => p === mac)
    assert.equal(c.app.name, "豆包")
    assert.equal(c.binary, mac)
  } finally {
    if (savedApp === undefined) delete process.env.DOUBAO_WORK_APP
    else process.env.DOUBAO_WORK_APP = savedApp
  }
})

test("envWithBins：PATH 分隔符按平台，已知目录补在最前", () => {
  const saved = process.env.PATH
  try {
    const sep = path.delimiter
    process.env.PATH = ["/a", "/b"].join(sep)
    const { PATH } = envWithBins()
    const dirs = PATH.split(sep)
    // 已知 bin 目录优先，其后保留用户原 PATH；分隔符必须是平台原生的
    assert.deepEqual(dirs.slice(0, dirs.length - 2), EXTRA_BIN_DIRS)
    assert.deepEqual(dirs.slice(-2), ["/a", "/b"])
    if (sep === ":") assert.ok(!PATH.includes(";"), "POSIX 不得混入 Windows 分隔符")
  } finally {
    process.env.PATH = saved
  }
})
