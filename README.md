# dsh-comments — 劃選點評插件

在 DSH 對話裏，用鼠標劃選助手回覆的**任意小段文字**，逐段點評：
選類型 → 寫意見 → 高亮標記。點評集中在一條結構化消息裏（引用 + 類型 +
意見，逐條編號），可**插入輸入框**（補充總述後發送）或**直接發送**，
讓下一輪智能體清晰知道上一輪輸出中哪些地方你不同意、不清晰或要改。

## 使用流程

1. 在任意一條助手消息上劃選一小段文字（鬆開鼠標後）→ 選區末端浮出 **✎ Markup** 按鈕。
2. 點擊 → **右側邊欄式編輯面板**（不遮正文；標題欄可拖動，位置記憶）：
   先選**點評類型**（不同意 / 不清晰 / 建議修改 / 提問 / 其他），再填
   **意見**（必填）。引用精確等於你所選的文字（表格儲存格以 `|` 分隔）。
3. 保存後該片段在原消息上持續高亮（類型色背景 + 2px 下劃線）；點擊高亮
   片段可直接重新編輯。
4. **側邊導航軌**（右緣細軌，Word 式頁邊標記）：每條點評一枚彩色刻度，
   位置對應其在對話滾動內容中的相對位置——懸停彈出**邊注卡**（類型 /
   第幾輪 / 引用摘要 / 意見，可定位、可編輯），點擊滾動到原文並閃爍。
4. composer 上方出現 **🏷 Markup 點評 N 處** 面板：
   - 展開可查看每條點評（類型 / 第幾輪 / 引用摘要 / 意見）；
   - 每條可 **定位**（滾動到原文並閃爍）、**✎ 編輯**、**✕ 刪除**；
   - **⤴ 插入輸入框**：把全部點評組裝成編號引用消息追加到草稿；
   - **直接發送**：組裝後立即作為下一條消息發出；
   - **清空**：兩段式確認後刪除本 session 全部點評。

## 生成的消息格式

```markdown
我對你先前回覆的 2 處片段有點評，請逐條對應處理：

1.〔不同意〕第 3 輪回覆

> 我們建議採用 A 方案，因為……

意見：這裡我不同意，B 方案更穩……

2.〔不清晰〕第 3 輪回覆

> 上下文會被自動壓縮

意見：「壓縮」具體丟掉哪些內容沒說清楚……

（以上由 Markup 劃選點評生成；請先確認你對每一處引用的理解，再逐條回應……）
```

> 模板規範（v0.2.1）：所有塊之間空行分隔——避免 markdown 惰性續行把
> 「意見」吞進引用塊；不用 `**` 裝飾（composer 是純文本，符號會原樣顯示）。

## 技術要點

- **錨定**：消息 DOM wrapper 自帶 `data-chat-turn` / `data-chat-node-key` /
  `data-chat-flow-kind`（dsh-client-ui-chat 的 flowItem）。標記錨 =
  (turn, 選區文本, 出現序號)，存 `localStorage`（per-session，上限 60
  sessions × 300 條）。
- **高亮**：CSS Custom Highlight API（`CSS.highlights` + `::highlight()`），
  **不改動** React 管理的 DOM；MutationObserver 監聽對話區重渲染後重新
  定位（表格/程式碼塊等選區會還原成 Markdown 引用，移植自 dsh-insights
  的 md-extract）。不支援的瀏覽器自動退化為「只有面板、無高亮」。
- **寫入通道**：`conversation.input.dock` 條目（session 作用域）優先經
  entry inject hook 走 `conversation.input.for(actx)` 服務路由（官方
  queue dock 同款），`props.inputActions`（provide 通道）為後備；兩者
  都不可用時退化为複製到剪貼板。
- **席位**：`shell.overlay`（id `markup-button`，劃選按鈕 + 編輯彈窗）、
  `conversation.input.dock`（id `markup-dock`，order 26，點評面板）。
  Host 半慣性（`dsh.client` 聲明即讓 `dsh-client-modules` 服務 client bundle）。
- 與 dsh-insights 的「加到筆記」選區按鈕**共存**：本插件按鈕錨在選區右端。

## 安裝 / 卸載

已列於 profile 的 `dsh.profile.bundles`（經 plugin_manager 安裝）。
卸載：Plugins 設置頁移除 bundle，或從 profile `package.json` 的
`dsh.profile.bundles` 刪去 `dsh-comments` 後重啟。

## 開發

純手寫 client bundle（無構建步驟）：改 `lib/client.js` → 重啟（或 HMR）
→ 刷新頁面。localStorage 鍵：`dsh-markup/marks/v1`。
