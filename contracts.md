# 来源网关契约

GET /streams/:id 返回定义版本及分量顺序；GET /observations?stream=...&page=... 返回 observationId、definition、phenomenonTime、result、locationRef。GET /definitions/:version 和 /locations/:id 返回历史对象；/locations/:id 可暂时为 404。定义版本和位置标识是来源标识，不允许使用抓取时的当前定义替代。

观测行携带的 definition 是观测当时的定义标识，可以和当前 /streams/:id 的定义不同；同一页可以混合多个版本。result 是该定义下的分量值序列，空值表示来源明确给出空值。探头与质量标记如出现在来源资料中，随所在观测、定义分量或 result 对象收存；来源未给出时不做推断。

## 本地来源操作

默认场景 normal，其他场景为 probe-change, location-pending。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。同一会话内首次读取 /locations/:id 返回 404、随后改为 200 的条目表示位置补发；其余重复读取仍保持首次结果。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

当前适配器 collect(client) 返回带字符串 id 的原件行，每行按观测行自带的定义版本解释分量顺序、单位和探头，并连同观测当时的位置对象、质量标记与解析状态收存；不能解释的观测保留引用和未解析原因，不以当前定义或猜测值填充。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容。ObservationLedger.apply(rows, provenance) 建立业务投影：定义或位置未解析时状态为 unresolved，值为缺失时状态为 partial，两者齐备为 confirmed；后续领取只补空位，已记录的定义、位置、探头和观测值不因补发或换版而改写，冲突保留在 conflicts 中。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。GET /records 保留兼容，GET /observations 与 /observations/unresolved 返回业务投影，不将未知状态伪造为成功。
