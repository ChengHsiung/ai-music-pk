# 真人 vs AI 音樂 PK

小朋友在 Yamaha 電子琴上彈 3 個音，真人音樂家與 AI 各自以這 3 個音為動機創作旋律，投影幕即時顯示五線譜。

需求規劃書：<https://claude.ai/code/artifact/9645e16c-d05e-4135-81bc-004f016dc52b>

## 目前進度

- [x] 第一階段：鍵盤與即時五線譜
- [x] 第二階段：AI 創作與演奏（含離線備援）
- [x] 第三階段：完整流程與主控台
- [ ] 第四階段：彩排與優化

## 使用方式

1. 用 USB 線把 Yamaha P-125 的 **USB TO HOST** 孔接到筆電。
2. 用 **Chrome** 或 **Edge** 開啟網頁版或離線版 `index.html`（見下方「離線版」）。
3. 瀏覽器詢問「是否允許使用 MIDI 裝置」時按 **允許**。右上角顯示綠色「鍵盤已連接」就成功了。
4. 按「測試鍵盤發聲」，Yamaha 應該會自己彈出 Do Mi Sol Do。
5. 筆電接投影機，設成「延伸桌面」。把主畫面拖到投影幕，按「全螢幕投影」。
6. 按「開啟主持人控制台」，控制台是另一個小視窗，放在筆電螢幕上操作。開啟後投影幕上的按鈕會藏起來，只剩音樂。

控制台被瀏覽器擋下時，請在網址列右側允許彈出式視窗。關掉控制台，按鈕會回到投影畫面下方。

### 一局的流程

控制台最上面的大按鈕「下一步」會一路帶著走（快捷鍵 →，在投影畫面或控制台按都可以）：

| 步驟 | 投影幕 | 可以重來 |
| --- | --- | --- |
| 開場 | 大標題與今天的玩法 | |
| ① 小朋友出題 | 只收前 3 個音，放大顯示唱名；彈滿 3 個音自動進下一步 | 重彈 3 個音 |
| ② 真人演奏 | 音符即時出現在五線譜，動機音標橘色；音樂家直接開始彈也可以 | 真人重來 |
| ③ 結束演奏 | 自動整理成 4/4 拍的樂譜 | 真人重來；速度抓錯時在「真人速度」輸入 BPM，樂譜會重排 |
| ④ AI 創作 | AI 用雙手從鍵盤（沒接鍵盤就從電腦喇叭的鋼琴音色）演奏，音符邊彈邊出現；左手伴奏以灰色顯示 | 換一首（會換一種曲風）、不等了改用離線 AI |
| ⑥ 並列樂譜 | 左邊真人、右邊 AI，請觀眾舉手投票 | 播放真人、播放 AI（播放時音符會亮起） |
| 下一局 | 局數加一，回到出題 | |

小朋友彈完 3 個音後，AI 就在背景開始創作，所以音樂家演奏完按 ④ 不用等。

快捷鍵：→ 下一步｜1 出題｜2 開始演奏｜3 結束演奏｜4 AI 創作｜5 暫停／繼續｜6 並列樂譜｜0 自由彈奏

### 每局紀錄

每一局自動記下小朋友的 3 個音、真人的演奏和 AI 的旋律，存在那台電腦的瀏覽器裡，重新整理頁面也不會不見。控制台的「每局紀錄」可以把每局的真人、AI 各下載成 MIDI 檔，用 GarageBand、MuseScore 等軟體開啟。活動結束後可按「清除所有紀錄」。

### AI 怎麼作曲

AI 寫的是一首有和弦的小歌，不只是一串音：

- **先寫和弦再寫旋律**：雲端 AI 用 ABC 樂譜（音樂人常用的文字記譜）寫旋律，每小節配一兩個和弦。
- **像一首歌**：小朋友的 3 個音是主題，會重複出現讓觀眾認得；有樂句、有換氣的休止、有一個高潮，最後回到主音。
- **曲風**：溫柔、抒情、輕快、勇敢、神秘五種，各有自己的速度範圍。預設由 AI 挑適合這 3 個音的曲風，「換一首」會換一種；主持人也可以在控制台指定。
- **雙手演奏**：左手伴奏依和弦與曲風產生（例如抒情是分解和弦、輕快是阿爾貝提低音、勇敢是進行曲），會換踏板（MIDI CC64），樂句尾稍微放慢、旋律唱出來、伴奏較輕。
- **電腦喇叭也像鋼琴**：沒接鍵盤時用內建的鋼琴取樣音色加一點殘響（離線版也有）。

### AI 設定

- 控制台（或畫面下方）可選 AI 旋律長度（8／12／16 小節）、曲風和演奏速度。速度留空表示用 AI 為這首曲子選的速度。
- 「AI 設定」可輸入 Anthropic API 金鑰，使用雲端 AI（Claude）作曲。沒有金鑰、沒有網路或雲端失敗時，會自動改用離線 AI，主持人也可以按「不等了，改用離線 AI」。
- 金鑰只存在那台電腦的瀏覽器裡（localStorage），不在程式碼或 GitHub 上。網頁版和離線版要各輸入一次。活動結束後可按「清除金鑰」。
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
- `src/ai/offlineComposer.ts`：離線 AI：樂段結構、動機重複／模進／倒影、和弦進行、半終止與正格終止
- `src/ai/cloudComposer.ts`：雲端 AI：請 Claude 先寫和弦、再用 ABC 樂譜寫旋律，回傳結構化 JSON
- `src/music/abc.ts`：讀 ABC 樂譜（音高、時值、休止、連結線）
- `src/music/chords.ts`：讀和弦記號、調內和弦
- `src/ai/accompaniment.ts`：依曲風把和弦編成左手伴奏與踏板；和弦缺漏時自動配和弦
- `src/ai/composer.ts`：選擇雲端或離線，失敗時自動改用離線
- `src/ai/melody.ts`：旋律格式檢查、曲風與速度、轉成樂譜
- `src/ai/player.ts`：MIDI 輸出到鍵盤（含踏板），有樂句呼吸、結尾漸慢、旋律與伴奏的力度；也能重播真人演奏（含踏板）
- `src/ai/piano.ts`：電腦喇叭用的鋼琴取樣音色與殘響
- `src/music/midiFile.ts`：把每局的旋律存成標準 MIDI 檔
- `src/ui/hostConsole.ts`：主持人控制台小視窗
- `src/main.ts`：一局的流程（開場 → 出題 → 真人 → AI → 並列樂譜）與每局紀錄

## 授權

程式碼為 MIT 授權。鋼琴取樣（`src/ai/piano/`）取自 [tonejs-instruments](https://github.com/nbrosowsky/tonejs-instruments)（npm 套件 `tonejs-instrument-piano-mp3`），以 [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) 授權，原作者整理自公有領域的錄音；這裡把每個取樣剪短到 3 至 5 秒並轉成單聲道。
