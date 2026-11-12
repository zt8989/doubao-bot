// pickNewTask 是「本次新会话落在哪」的判据：只认侧边栏任务集合的差集，不认窗口 id。
// 这条回归对应 #228 的两次假结论：新建前后窗口 id 相同 → 误判成「没建出来」，
// 编排就去重派了一条；窗口 id 不同 → 把用户自己那条会话记成了本次新会话。
import test from "node:test"
import assert from "node:assert/strict"
import { pickNewTask, taskIds, freshTaskCandidates } from "../src/util.mjs"

const t = (id, title, extra = {}) => ({ id, title, running: false, unread: 0, project: "", ...extra })

test("before 没有、after 多出来一条 → 认它（窗口 id 是旧会话也不影响）", () => {
  const before = [t("38453301376290562", "修复接口兼容性问题")]
  const after = [t("38453031255662594", "修复历史会话PDF附件解析文本展示问题"), ...before]
  const hit = pickNewTask(before, after)
  assert.equal(hit?.id, "38453031255662594")
})

test("before/after 没有新增 → null（这次确实没建出新任务，才允许判失败）", () => {
  const before = [t("38453301376290562", "修复接口兼容性问题")]
  assert.equal(pickNewTask(before, before), null)
  assert.equal(pickNewTask(before, []), null)
})

test("用户同时建了两条：标题对得上的优先", () => {
  const before = [t("38453301376290562", "修复接口兼容性问题")]
  const after = [
    t("38453400133796098", "续跑与自动合并", { running: true }),
    t("38453235018998530", "修复历史会话PDF解析文本展示问题"),
    ...before,
  ]
  const hit = pickNewTask(before, after, { expectTitle: "修复历史会话PDF解析文本展示问题" })
  assert.equal(hit?.id, "38453235018998530")
})

test("标题里有空白/零宽字符也能对上", () => {
  const before = []
  const after = [
    t("38453399370961666", "harness 支持双端上下文与产物URL"),
    t("38453030941511426", "配置提示词与项目路径"),
  ]
  const hit = pickNewTask(before, after, { expectTitle: "harness支持双端上下文与产物URL" })
  assert.equal(hit?.id, "38453399370961666")
})

test("没有标题线索时，正在跑的那条优先（我们刚发出去的提示词就在跑）", () => {
  const before = [t("38453301376290562", "修复接口兼容性问题")]
  const after = [
    t("38453346828920834", "开工"),
    t("38453031255662594", "修复历史会话PDF附件解析文本展示问题", { running: true }),
    ...before,
  ]
  const hit = pickNewTask(before, after)
  assert.equal(hit?.id, "38453031255662594")
})

test("都没在跑时取列表最上面（豆包把新建的任务插在最前）", () => {
  const before = [t("38453301376290562", "修复接口兼容性问题")]
  const after = [t("38453400133796098", "续跑与自动合并"), t("38453347816896002", "工单 #268 继续处理"), ...before]
  const hit = pickNewTask(before, after)
  assert.equal(hit?.id, "38453400133796098")
})

test("新建前侧边栏一条任务都没有（干净的豆包）→ 仍能认出唯一那条", () => {
  const after = [t("38453031255662594", "修复历史会话PDF附件解析文本展示问题")]
  assert.equal(pickNewTask([], after)?.id, "38453031255662594")
})

test("id 不是 8 位以上数字的条目不算任务（空 id、被超链接截断的路径）", () => {
  const before = [t("38453301376290562", "修复接口兼容性问题")]
  const after = [t("", "空 id"), t("chat/abc", "不是数字"), t("38453031255662594", "真的新任务"), ...before]
  assert.equal(pickNewTask(before, after)?.id, "38453031255662594")
})

test("关键：判据只有差集，台账里那个「别的会话 id」不参与判断", () => {
  // #228 attempt 2 的现场：窗口停在用户的 38453301376290562，提示词实际落在新会话。
  const before = [t("38453301376290562", "修复接口兼容性问题"), t("38453234955822338", "已运行单的状态")]
  const after = [t("38453235018998530", "修复历史会话PDF解析文本展示问题"), ...before]
  const hit = pickNewTask(before, after)
  assert.notEqual(hit?.id, "38453301376290562")
  assert.equal(hit?.id, "38453235018998530")
})

test("taskIds 只留合法会话 id", () => {
  const ids = taskIds([t("38453031255662594", "a"), t("", "b"), { nope: 1 }, null])
  assert.deepEqual([...ids], ["38453031255662594"])
})

test("并发多建：没标题线索时，当前被选中的那条优先（刚点新建的通常就是它）", () => {
  const before = [t("38453301376290562", "修复接口兼容性问题")]
  const after = [
    t("38452531808461570", "续跑#268任务", { active: false }),
    t("38452223875281410", "收到", { active: true }),
    ...before,
  ]
  const [first] = freshTaskCandidates(before, after)
  assert.equal(first?.id, "38452223875281410")
})

test("并发多建：标题命中的排最前，哪怕它不是当前选中的", () => {
  const before = []
  const after = [
    t("38452531808461570", "续跑#268任务", { active: true }),
    t("38452223875281410", "只回复两个字收到"),
  ]
  const cands = freshTaskCandidates(before, after, { expectTitle: "只回复两个字收到" })
  assert.equal(cands[0]?.id, "38452223875281410")
  assert.equal(cands.length, 2)
})

test("pickNewTask 就是候选里的第一个", () => {
  const before = [t("38453301376290562", "修复接口兼容性问题")]
  const after = [t("38452531808461570", "续跑#268任务"), t("38452223875281410", "收到"), ...before]
  const cands = freshTaskCandidates(before, after)
  assert.equal(pickNewTask(before, after)?.id, cands[0]?.id)
})
