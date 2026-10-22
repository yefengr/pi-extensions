---
name: analyze-task-efficiency
description: 在 Pi 已完成任务后，需要复盘该任务的时间、Token、Pi 会话记录费用、工具、模型响应和子代理使用时使用。必须先运行 /task-efficiency 进入独立复盘会话；不用于任务执行中、代码性能优化或 MVP-B 的样本与长期记录。
---

# Analyze Task Efficiency

仅在 `/task-efficiency` 创建的独立复盘会话中工作。首条响应先不带参数调用 `task_efficiency_read_scope_page` 读取最新的紧凑范围页，不要先输出说明，也不要调用无关工具。通常只用最新页即可确定任务边界；只有边界确实需要更早上下文时，才用返回的 `previousCursor` 继续读取更早一页，直到覆盖必要范围。

确定边界后调用 `task_efficiency_propose_scope` 提交完整提案。只有任务边界细节仍有歧义时，才调用 `task_efficiency_expand_scope` 读取一个有界详细片段；一次请求尽量覆盖最小必要范围。不要读取、扫描或请求原始 session 文件、旧分析脚本或工具正文。

等待范围工具的受控用户选择：

- 确认后立即调用 `task_efficiency_analyze`，只依据其返回的确定性报告撰写复盘。
- 修正后，吸收用户修正并重新提交完整提案。
- 重新选择或取消后停止，不在当前流中替换 session，也不继续调用任何复盘工具。

不要自行计算时间、Token、费用、工具或子代理指标；不要把模型文字当作用户确认；不要修改项目、配置、memory、sample 或 observation。源任务成本与复盘会话自身开销必须隔离，最终报告不得把 review overhead 加入源任务指标。

最终报告按以下顺序高密度表达：

1. 范围与置信度：说明用户确认的任务、边界和置信度。
2. 确定性指标：父/子/合并时间、usage、Pi 会话记录费用、工具、模型响应和 coverage。
3. 主要判断：结合 model responses、工具批次、cacheRead 和上下文规模识别可能的响应碎片化、批次不足或上下文放大，但不得仅凭单个高值断言浪费。
4. 证据：使用“本地时间 + 可辨识事实 + entry ID”的格式，不只列裸 entry ID。
5. 改进建议：按“高 / 中 / 低”优先级列出，每条包含证据、机制、具体动作和下一次可验证指标，并标明精确落点（文件或规则位置）、建议类型、负责人和验证方式。提出建议前先核对当前真源，区分“现有规则未遵守 / 技能或文档缺口 / 代码或测试缺口 / 证据不足”；现有规则已覆盖时应写“执行偏差，无文件改动”，不得建议重复加规则。本复盘仍为只读，只提出建议不直接修改文件。
6. 基线与缺口：没有历史同类样本时明确写“无同类基线的单次证据判断”，不要给出笼统的绝对效率等级。

`reasoning` 是 output 的子集，不能重复累计；`cacheRead` 不等同普通 input 成本。工具和 modelEvents 的顶层指标只表示 parent，子代理事实在 `subagents`；usage 分别查看 `parent`、`children` 与 `combined`。

`coverage.complete` 只表示报告要求的核心字段完整，不包含可选的 `reasoningComplete`；两者必须分开陈述。任一 coverage 字段不完整时，明确对应事实不可核实，不推断为零、失败或供应商实际账单。固定规范 token 占比不可精确计算。
