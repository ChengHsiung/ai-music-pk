# 真人 vs AI 音樂 PK

小朋友在 Yamaha 電子琴上彈 3 個音，真人音樂家與 AI 各自以這 3 個音為動機創作旋律，投影幕即時顯示五線譜。

需求規劃書：<https://claude.ai/code/artifact/9645e16c-d05e-4135-81bc-004f016dc52b>

## 目前進度

- [x] 第一階段：鍵盤與即時五線譜
- [x] 第二階段：AI 創作與演奏（含離線備援）
- [ ] 第三階段：完整流程與主控台
- [ ] 第四階段：彩排與優化

## 使用方式

1. 用 USB 線把 Yamaha P-125 的 **USB TO HOST** 孔接到筆電。
2. 用 **Chrome** 或 **Edge** 直接開啟離線版 `index.html`（見下方「離線版」）。
3. 瀏覽器詢問「是否允許使用 MIDI 裝置」時按 **允許**。右上角顯示綠色「鍵盤已連接」就成功了。
4. 按「測試鍵盤發聲」，Yamaha 應該會自己彈出 Do Mi Sol Do（第二階段 AI 演奏會用到）。
5. 筆電接投影機，按「全螢幕投影」。

### 一局的流程

| 步驟 | 按鈕／快捷鍵 | 畫面 |
| --- | --- | --- |
| 小朋友出題 | ① 小朋友出題（鍵 1） | 只收前 3 個音，左側放大顯示唱名 |
| 重彈 | 重彈 3 個音 | 清掉重來 |
| 音樂家演奏 | 直接開始彈，或 ② 開始演奏（鍵 2） | 音符即時出現在五線譜，動機音標橘色 |
| 結束 | ③ 結束演奏（鍵 3） | 自動整理成 4/4 拍、有小節線的樂譜 |
| 速度不對 | 在「速度」輸入 BPM 後按「重新整理樂譜」 | 依指定速度重排 |
| AI 創作 | ④ AI 創作（鍵 4） | AI 從鍵盤（沒接鍵盤就從電腦喇叭）演奏，音符邊彈邊出現在五線譜上 |
| 暫停／繼續 | ⏸ 暫停（鍵 5） | 演奏完按同一顆鈕可再聽一次 |
| 換一首 | 換一首 | 用同樣 3 個音再創作一首 |

小朋友彈完 3 個音後，AI 就在背景開始創作，所以音樂家演奏完按 ④ 不用等。

### AI 設定

- 畫面下方可選 AI 旋律長度（8／12／16 小節）和演奏速度。
- 「AI 設定」可輸入 Anthropic API 金鑰，使用雲端 AI（Claude）作曲。沒有金鑰、沒有網路或雲端失敗時，會自動改用離線 AI，主持人也可以按「不等了，改用離線 AI」。
- 金鑰只存在那台電腦的瀏覽器裡（localStorage），不在程式碼或 GitHub 上。活動結束後可按「清除金鑰」。
- 「測試雲端 AI」會實際請 Claude 寫一段 8 小節旋律，確認金鑰和網路都正常。

沒有鍵盤時可用畫面下方的螢幕鍵盤，或電腦鍵盤 `A W S E D F T G Y H U J K`（A = Do），`Z`／`X` 降／升八度。

## 離線版

`npm run build` 會產生單一檔案 `dist/index.html`，樂譜字型與程式全部包在裡面。複製到筆電後直接雙擊即可，不需要網路。

每次推送到 GitHub，Actions 的執行頁面也會附上這個檔案（`ai-music-pk-offline`），可直接下載。

網頁版：<https://chenghsiung.github.io/ai-music-pk/>，合併到 main 後自動更新（需要 Settings → Pages 的 Source 選 **GitHub Actions**，並在 Actions Variables 設定 `DEPLOY_PAGES` = `true`）。

## 開發

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 單元測試
npm run build      # 產生 dist/index.html
```

技術：Vite + TypeScript、[VexFlow](https://www.vexflow.com/) 樂譜繪製、瀏覽器內建 Web MIDI。

- `src/io/midi.ts`：鍵盤 MIDI 收發
- `src/io/virtualKeyboard.ts`：螢幕鍵盤與電腦鍵盤
- `src/music/theory.ts`：音名拼寫、唱名、調性判斷
- `src/music/quantize.ts`：把自由演奏整理成小節與音符時值
- `src/render/notation.ts`：即時五線譜與完整樂譜（AI 樂譜可逐音顯示）
- `src/ai/offlineComposer.ts`：離線 AI：樂段結構、動機重複／模進／倒影、半終止與正格終止
- `src/ai/cloudComposer.ts`：雲端 AI：請 Claude 依規則續寫，回傳結構化 JSON
- `src/ai/composer.ts`：選擇雲端或離線，失敗時自動改用離線
- `src/ai/melody.ts`：旋律格式檢查與轉成樂譜
- `src/ai/player.ts`：MIDI 輸出到鍵盤或用電腦喇叭合成，含強弱拍與結尾漸慢
