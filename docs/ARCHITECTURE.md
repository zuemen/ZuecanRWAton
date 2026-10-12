# 架構

本文說明 ZuecanRWAton 的帳本模型：每份合約由誰簽署、誰看得到，以及模型保證哪些不變式。另外記錄幾個設計取捨的理由。

程式碼位置一律以 `檔案:符號` 標示，相對於 repo 根目錄。

## 1. Daml 的授權模型：先懂這三條

1. **建立一份合約，要所有 signatory 的授權。** 例如持有部位 `FundHolding` 有三位 signatory（過戶代理、託管機構、持有人），所以沒有任何一方能單獨變出一份。
2. **choice 執行時，擁有「該合約全部 signatory＋這個 choice 的 controller」的授權**，但不會繼承外層 choice 的授權。
   因此像交割這種同時需要買方、賣方、過戶代理的動作，要先由大家共同簽一份中間合約（`MatchedTrade`），再在它的 choice 裡完成。
3. **合約不可修改，只能封存再建立新的。** 「更新」其實是 consuming choice 封存舊合約、建立新合約；拿著舊合約 id 的人會失敗。
   基金條款修訂、NAV 更新、憑證撤銷都利用這點，讓變更立刻生效。

## 2. 合約一覽：簽署方與觀察方

| 合約 | signatory | observer | 說明 |
|---|---|---|---|
| `Compliance:CredentialRequest` | 投資人 | KYC 機構 | 投資人申請 |
| `Compliance:InvestorCredential` | KYC 機構 | 投資人、`relying`（過戶代理、交易場所、託管）、監理 | 個資留在鏈下，只放 `evidenceHash` |
| `Compliance:CredentialRevocation` | KYC 機構 | 投資人、監理 | 撤銷紀錄 |
| `Cash:CashHolding` | 穩定幣發行人 | 持有人 | 發行人可凍結或銷毀，和法幣穩定幣一致 |
| `Cash:LockedCash` | 穩定幣發行人 | 持有人、`lockedTo`、`payee` | 託管中的現金；`committed` 表示已承諾給一筆成交 |
| `Fund:FundTerms` | **過戶代理＋監理** | 託管、行政、KYC、場所、Public | 基金條款，`offeringDocHash` 指向公開說明書 |
| `Fund:TermsProposal` | 過戶代理 | 監理 | 首版條款或修訂提案，監理核准才生效 |
| `Fund:NavReport` | 基金行政 | 過戶代理、`readers` | 每份只有一個有效版本 |
| `Registry:RegisterProposal` | 過戶代理 | 託管 | 任命託管機構 |
| `Registry:FundRegister` | **過戶代理＋託管** | 監理、Public | 雙簽帳冊 |
| `Registry:ReserveAttestation` | 託管 | 過戶代理、`readers` | 儲備聲明歷史：持倉明細、投資組合指標、違規項目 |
| `Registry:FundHolding` | **過戶代理＋託管＋持有人** | 監理 | 持有部位 |
| `Registry:TransferOffer` | 過戶代理＋託管＋轉出人 | 受讓人、監理 | 場外轉讓的託管 |
| `Registry:SellOrder` | 過戶代理＋託管＋賣方 | 指定買方、場所、監理 | 詢價回覆（確定報價） |
| `Registry:MatchedTrade` | 過戶代理＋託管＋賣方＋買方 | 場所、監理 | 待交割 |
| `Registry:RedemptionRequest` | 過戶代理＋託管＋投資人 | 監理 | 贖回申請 |
| `Registry:RedemptionPayout` | 過戶代理＋託管＋投資人 | 監理 | 已定價、待付款 |
| `Registry:EnforcementRecord` | 過戶代理 | 持有人、監理 | 凍結、解凍、扣押、召回紀錄 |
| `Market:MarketProposal` | 交易場所 | 監理 | 交易場所申請，監理核准才建立控制合約 |
| `Market:MarketControl` | **交易場所＋監理** | 過戶代理、`readers` | 停牌、價格帶、單筆上限 |
| `Market:TradePrint` | 交易場所 | Public、監理 | 公開成交資訊，不含身分 |
| `Market:RegulatoryTradeReport` | 交易場所 | 監理 | 含雙方身分 |
| `Subscription:SubscriptionRequest` | 投資人 | 過戶代理 | 申購申請 |

## 3. 隱私矩陣

由各合約的 signatory 與 observer 推得；`Test.Secondary:privacyOfHoldings` 直接查詢驗證了持有部位、KYC 與公開資料的部分。

| | 自己的部位 | 別人的部位 | 別人的 KYC | 帳冊總量／NAV／儲備聲明 | 成交價量 | 成交雙方 |
|---|---|---|---|---|---|---|
| 投資人 | ✅ | ❌ | ❌ | ✅（以 `readAs Public`） | ✅（以 `readAs Public`） | 只有自己參與的 |
| 交易場所 | — | 持有部位 ❌；只看到經手成交中的託管份數 | 只限 `relying` 名單 | NAV ✅；帳冊、聲明以 `readAs Public` | ✅ | ✅ |
| 託管機構 | — | ✅（共簽每份份數合約） | 只限 `relying` 名單 | ✅ | 以 `readAs Public` | ✅（共簽 `MatchedTrade`） |
| 監理機關 | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| Public | — | ❌ | ❌ | ✅ | ✅ | ❌ |

Canton 只把合約送到它的 stakeholder 所在的 participant，所以這張表不只是「畫面上看不到」，而是**別人的節點根本沒有這筆資料**。這是 Canton 和公鏈最大的不同。

## 4. 不變式

| # | 不變式 | 怎麼保證 | 測試 |
|---|---|---|---|
| I1 | 發行後，流通份數 × NAV ≤ 已證明儲備＋聲明後的鏈上淨流入 | `FundRegister.RecordIssuance` 每筆檢查 | `underReservedFundStopsIssuingAndRedeeming` |
| I2 | 儲備聲明或 NAV 超過 30 小時，不能發行或贖回 | `isWithin maxAttestationAge`、`checkNav` | `staleAttestationOrNavBlocksIssuance` |
| I3 | 儲備已低於負債時，不能以 NAV 贖回 | `RecordRedemption` 先檢查覆蓋 | 同 I1 |
| I4 | 取得份數的人，一定持有有效、合格、篩檢未逾期的憑證 | 申購、受讓、成交三條路徑都呼叫 `checkEligible` | `ineligibleInvestorsCannotSubscribe`、`transfersNeedAnEligibleReceiver`、`ineligibleBuyerCannotReceiveUnits` |
| I5 | 被制裁的人拿不到錢，也不能把份數轉走 | `checkScreened`：交割時對賣方、核准與付款贖回時對贖回人、場外轉讓時對轉出人 | `sanctionedSellerIsNotPaid`、`redeemerMustBeScreened`、`sanctionedRedeemerIsNotPaid`、`escrowedUnitsCanBeRecalled` |
| I6 | 份數與價金在同一筆交易交換，不會只交一邊 | `MatchedTrade.Settle` 單一交易 | `rfqTradeSettlesDeliveryVersusPayment` |
| I7 | 託管中的資產永遠有出口（依法律命令凍結的除外） | 現金鎖定到期由持有人取回；交割逾期買賣雙方都可中止；贖回款逾期未付，投資人取回份數（`ReclaimUnits`） | `counterpartiesCanWalkAwayAfterTheDeadline`、`buyerCanAbortAfterTheDeadline`、`subscriptionCashIsNeverStuck`、`unpaidRedemptionLapsesToTheInvestor` |
| I8 | 鎖定到期後，場所不能再把錢付給賣方 | `PayOut` 要求 `now < releaseAfter`，`Take` 要求鎖定到期日＝交割期限 | `takeRequiresAMatchingLock`、`counterpartiesCanWalkAwayAfterTheDeadline` |
| I8a | 託管中的現金只能在持有人簽署的流程裡付出（申購單、成交合約），`lockedTo` 不能單方付款 | `PayOut` 的 controller 是 `lockedTo`＋持有人 | `subscriptionCashIsNeverStuck`、`counterpartiesCanWalkAwayAfterTheDeadline` |
| I9 | 監理停牌只有監理能解除；交易場所不能換掉控制合約，也不能自行放寬限制 | `MarketControl` 由場所＋監理簽署；`Settle` 檢查控制合約的監理；`SetLimits` 只能收緊 | `haltsStopSettlement`、`venueCannotEscapeTheRegulator` |
| I10 | 帳冊不能被單方改寫 | `FundRegister` 雙簽 | `noSinglePartyCanRewriteTheBook` |
| I10a | 過戶代理不能自行發行：發行需要申購人的授權，只有申購人自己簽的 `SubscriptionRequest` 帶得到；並且會消耗申購人鎖定的現金，份數由帳冊按 NAV 計算 | `RecordIssuance` 的 controller 是過戶代理＋申購人 | 同上 |
| I10b | 註銷份數需要過戶代理＋託管機構，且付款額必須為正（負數會虛增儲備覆蓋） | `RecordRedemption` 的 controller | 同上 |
| I10c | 帳冊之外不可能出現份數：每份份數合約都要託管機構簽署，而託管機構只在帳冊的發行、以及已在帳冊上的份數移動時簽 | `FundHolding` 與所有份數託管合約的 signatory | 同上 |
| I11 | 監理看得到的所有份數（含託管中）＝帳冊流通量 | 由 I10a–I10c 保證；監理端也能對帳 | 31 個移動份數的情境結尾的 `checkReconciles` |
| I12 | 條款只能經監理核准修訂；核准後舊條款立即失效 | `FundTerms` 由過戶代理＋監理簽署，修訂走 `TermsProposal.ApproveTerms`，同時封存舊版 | `amendedTermsSupersedeOldOnes` |
| I13 | 儲備數字等於託管機構申報的持倉市值總和，不能另填 | `Attest` 由持倉計算 | `reserveIsTheSumOfPositions` |
| I14 | 投資組合違反 Rule 2a-7 限制（WAM、WAL、最長到期、每日／每週流動資產、政府資產占比）時，停止新申購；違規項目公開；贖回不受影響 | `Attest` 記錄 `portfolioBreaches`，`RecordIssuance` 要求為空 | `breachingPortfolioStopsSubscriptionsOnly`、`eachLimitIsEnforced`、`metricsFollowRule2a7Definitions` |
| I15 | 一份現金鎖定只能支撐一筆成交 | `Take` 對鎖定行使 `Commit` | `oneLockBacksOneTrade` |
| I16 | 贖回款只以仍然有效的定價 NAV、在 `payBy` 前、從託管機構自己的現金付出 | `Pay` 比對 `navSeq`、`payBy` 與現金持有人 | `stalePricedPayoutIsRefused`、`redemptionIsPaidFromCustodyCash` |
| I17 | 託管中的份數也在執法範圍內 | 五種託管合約都有 `Recall`，份數回到原持有人並凍結 | `escrowedUnitsCanBeRecalled` |

## 5. 設計取捨

### 為什麼次級市場不用 AMM（Uniswap 式流動性池）
Daml 合約不能修改。每一筆 swap 都要封存並重建**同一份**池子合約，所有交易者都在搶它，後送出的交易會因為合約已被封存而失敗。
Canton 上的交易一般採詢價（RFQ）或雙邊款券同步交割（DvP），本平台採用後者。
如果之後一定要 AMM，可以考慮把池子放在 EVM 上，Canton 只負責發行與帳冊；這需要跨鏈橋接，不在本原型範圍內。

### 為什麼沒有 contract key
Canton 3.x 不支援 contract key 的唯一性查詢。所以每個 choice 都要求呼叫者明確傳入相關合約的 id（條款、NAV、憑證、帳冊），再在 choice 裡驗證這些合約屬於同一檔基金、同一個角色。
這也讓「舊版本立即失效」成立：拿舊 id 的交易一定失敗。

### 為什麼帳冊要雙簽，發行還要申購人授權
如果只有過戶代理簽，它可以封存帳冊再建立一份新的，把流通份數或儲備改成任意數字。雙簽之後，帳冊的任何變動都只能走雙方同意的 choice：
- 儲備數字只有託管機構能寫（`Attest`）；
- 註銷份數要過戶代理和付款的託管機構一起（`RecordRedemption`）。

光是雙簽還不夠。早期版本的 `RecordIssuance` 只要過戶代理一方，而且「收到多少現金」是呼叫者自己填的：過戶代理可以謊報現金、虛增儲備覆蓋，再發份數給自己，帳冊和持有部位還對得上。現在的版本：
- controller 是**過戶代理＋申購人**。申購人的授權只存在於申購人自己簽的 `SubscriptionRequest` 裡，所以只有真的申購能觸發發行。
- 它**消耗**申購人的 `LockedCash`（付給託管機構），現金是真的，而且只能算一次。
- 份數由帳冊用當下 NAV 計算並回傳，呼叫者不能指定。
- 資格檢查、最低申購額、儲備覆蓋都在這裡做。帳冊是發行唯一的關卡。

### 為什麼託管機構要共簽每一份持有部位
只靠帳冊雙簽，還有一個洞：持有部位原本只由「過戶代理＋持有人」簽署，當持有人就是過戶代理自己時，它一個人就能建立份數，完全不經過帳冊。

現在每份份數合約（持有部位，以及託管中的轉讓、賣單、成交、贖回）都多了託管機構這位 signatory。託管機構的授權只會出現在兩個地方：
- 帳冊的 `RecordIssuance`：帳冊由託管機構共簽，所以發行時可以直接在這裡建立持有部位；
- 已經在帳冊上的份數移動：這些託管合約本身就有託管機構的簽名。

所以份數總量只能經由帳冊增加；要在帳冊外變出份數，必須過戶代理和託管機構串通。代價是隱私：託管機構的 participant 看得到所有持有人。

### 為什麼儲備聲明要附持倉明細
早期版本只有一個「儲備總值」數字。現在託管機構申報的是持倉清單（證券代號、種類、面額、市值、到期日、利率重設日），帳本：
- 以市值總和作為儲備，申報者無法另填一個不一致的數字；
- 依基金條款的 `portfolioRules`（預設是政府貨幣基金的 Rule 2a-7 限制）計算 WAM、WAL、最長到期、每日／每週流動資產與政府資產占比；
- 有違規時照樣記錄並公開（隱藏更糟），但停止新申購，直到託管機構申報合規的組合。

營業日以日曆日近似；指標定義是撰寫者對 Rule 2a-7 的整理，引用前請對照 17 CFR 270.2a-7 原文。

### 為什麼交易場所的控制合約要監理共簽
早期版本的 `MarketControl` 只有交易場所一位 signatory。獨立審查證明它可以封存監理停牌中的控制合約，另立一份「交易中」的來交割，也能任意放寬價格帶。
現在交易場所只能提出 `MarketProposal`，監理核准（`AcceptMarket`）才建立控制合約，而且控制合約由雙方共同簽署，任何一方都不能單獨封存。`Settle` 另外檢查控制合約的監理就是本基金的監理。交易場所自己只能收緊限制（`SetLimits`），放寬要監理（`RegulatorSetLimits`）。

### 為什麼贖回付款時要再檢查一次
核准和付款之間有時間差。審查證明了三種攻擊：投資人在這段時間被列入制裁名單；NAV 在這段時間下修，但仍照舊價格付款，損失由留下的持有人承擔；託管機構拿投資人自己的現金「付款」。付款合約由投資人簽署，所以 choice 本體帶有投資人的授權，可以動用投資人的現金。
現在 `Pay` 重新篩檢投資人，要求傳入的 NAV 報告仍是定價時那一份（`navSeq`），並要求現金屬於託管機構。付款還有期限 `payBy`，過期後投資人可以自行取回份數，不必等任何機構配合。

### 為什麼託管中的份數也能被召回
凍結與扣押原本只作用在持有部位。持有人把份數放進託管合約（轉讓、賣單、成交、贖回），就能讓它留在執法範圍外。現在五種託管合約都有 `Recall`：附上法律命令編號，份數以凍結的部位回到原持有人，之後再依法扣押。場外轉讓也會先檢查轉出人的篩檢，被制裁的人不能把份數贈與他人。

### 為什麼基金條款要監理機關共簽
條款決定誰的 KYC 憑證算數、哪個交易場所能交割、結算資產是什麼、適用哪些投資組合限制。只由過戶代理簽署時，它可以一個人把 KYC 機構換成自己、放寬限制。
現在條款由過戶代理和監理機關共同簽署：過戶代理只能提出 `TermsProposal`，監理核准（`ApproveTerms`）時才建立新版並封存舊版。

### 為什麼 NAV 是累積型
貨幣基金有兩種做法。
- **穩定 $1、每日配息再投資**（BUIDL 型）：每天要對每一個持有部位發新份數。在 Daml 裡等於每天把所有持有部位封存重建一次，成本高，也會和交易搶合約。
- **NAV 上升、不配息**（OUSG 型）：每天只需要更新一份 `NavReport`。

本原型採後者。

### 為什麼申購贖回用「處理當下」的 NAV
這是共同基金的 forward pricing 規則（Rule 22c-1），避免投資人拿已知的舊價格套利。

### 為什麼現金鎖定要指定收款人與到期日
`LockedCash` 讓第三方（過戶代理、交易場所）有權動用投資人的錢，但權限被限縮到最小：
- 只能付給約定的一位 `payee`；
- 只能在 `releaseAfter` 之前付；
- 付款要 `lockedTo` **和持有人**雙方授權，所以只能在持有人簽署的流程裡發生（申購單、作為買方的成交合約）。早期版本只要 `lockedTo`，過戶代理可以在投資人取消申購後，仍把錢付給託管機構卻不發份數；
- 過了 `releaseAfter` 之後只有持有人能取回；
- 承接賣單時（`Take`）鎖定會被標記為已承諾（`Commit`），同一份鎖定不能再承接第二張賣單，否則第二位賣方的份數會卡到期限。

所以交易場所無法挪用買方的錢，也不能在交割中止後再付給賣方。

### 為什麼 `main` 不依賴 daml-script
Canton 3.x 的 Smart Contract Upgrade 要求上帳本的 package 乾淨；測試程式放在另一個 package（`test/`），不會跟著上傳。

## 6. 已知的信任假設

- **過戶代理和託管機構串通，可以在帳冊外建立份數。** 兩者都是受監理機構，帳冊本來就由它們共管；監理機關看得到所有持有部位，可以持續對帳（`checkReconciles` 示範）。
- **託管機構申報的持倉靠託管機構誠實。** 正式環境應加上獨立稽核師的定期確信報告。
- **NAV 靠基金行政誠實。** 帳本只檢查 NAV 是否新鮮，不檢查它算得對不對。
- **唯一性靠程序。** 沒有 contract key，帳本不保證每檔基金只有一本帳冊、只有一份第 1 版條款。前者需要過戶代理與託管機構合作，後者需要監理機關核准兩次；監理看得到兩者，可以發現。

## 測試與突變測試

```
scripts/daml-test.sh     # IDE ledger：daml test --show-coverage --all
scripts/canton-test.sh   # Canton sandbox participant：Test.Canton:allScenarios
```

- 37 個情境全數通過，**在 IDE ledger 與真正的 Canton participant 上都通過**（2026-10-12）。帳本 package 的 23 個 template 都有被建立（另有測試用的 `Heartbeat`），`scripts/daml-test.sh` 會檢查這一點。
- `Test.Adversarial` 的 8 個情境是一次獨立對抗式審查找到的攻擊（F1–F7）的回歸測試，每一個都必須被拒絕。詳見 [`SPECIFICATION.md`](SPECIFICATION.md) 10.5。
- 沒被執行到的 choice 只有各 template 內建的 `Archive`（多簽合約的單方 Archive 由 `noSinglePartyCanRewriteTheBook` 驗證會失敗）。
- Canton 實跑踩到兩件 IDE ledger 不會發生的事，都已處理：
  - **`daml script --all` 會平行執行腳本**，而靜態時間的時鐘是共用的，一個情境快轉時間會打壞另一個情境的期限。改成由 `Test.Canton:allScenarios` 依序執行。
  - **時間一次快轉數小時或數天後，synchronizer 會中斷並重建 sequencer 連線**，之後的第一筆交易會失敗（`SEQUENCER_REQUEST_FAILED`，接著是 `UNKNOWN_CONTRACT_SYNCHRONIZERS`）。`advanceTime` 快轉後會用一份 `Heartbeat` 合約探測，等到交易能送出再繼續。

**突變測試**：逐一把 80 條關鍵檢查、計算或授權拿掉（條件改成永遠成立、刪掉檢查、改變一個計算，或少一個 signatory／controller），確認至少一個測試因此失敗。結果見下表（2026-10-12，Daml SDK 3.4.0-rc2，最終程式碼）。

| 突變 | 結果 | 第一個失敗的情境 |
|---|---|---|
| abort actor | ✅ 被抓到 | `Secondary.counterpartiesCanWalkAwayAfterTheDeadline` |
| abort deadline | ✅ 被抓到 | `Secondary.counterpartiesCanWalkAwayAfterTheDeadline` |
| agency notes weekly liquid | ✅ 被抓到 | `Portfolio.eachLimitIsEnforced` |
| amendment archives old terms | ✅ 被抓到 | `Primary.amendedTermsSupersedeOldOnes` |
| buyer eligibility | ✅ 被抓到 | `Secondary.ineligibleBuyerCannotReceiveUnits` |
| cash transfer bound | ✅ 被抓到 | `Controls.housekeeping` |
| credential expiry | ✅ 被抓到 | `Primary.expiredCredentialIsRefused` |
| credential issuer | ✅ 被抓到 | `Adversarial.escrowedUnitsCanBeRecalled` |
| credential owner | ✅ 被抓到 | `Adversarial.sanctionedRedeemerIsNotPaid` |
| daily liquidity limit | ✅ 被抓到 | `Portfolio.eachLimitIsEnforced` |
| first terms version | ✅ 被抓到 | `Primary.amendedTermsSupersedeOldOnes` |
| frozen escrow | ✅ 被抓到 | `Secondary.freezeAndSeizeUnderLegalOrder` |
| gift sender screening | ✅ 被抓到 | `Adversarial.escrowedUnitsCanBeRecalled` |
| government share limit | ✅ 被抓到 | `Portfolio.eachLimitIsEnforced` |
| holding custodian signature | ✅ 被抓到 | `Adversarial.oneLockBacksOneTrade` |
| holding dual signature | ✅ 被抓到 | `Controls.noSinglePartyCanRewriteTheBook` |
| investor class | ✅ 被抓到 | `Primary.ineligibleInvestorsCannotSubscribe` |
| investor reclaim waits for payBy | ✅ 被抓到 | `Adversarial.unpaidRedemptionLapsesToTheInvestor` |
| issuance attestation freshness | ✅ 被抓到 | `Primary.staleAttestationOrNavBlocksIssuance` |
| issuance coverage | ✅ 被抓到 | `Primary.underReservedFundStopsIssuingAndRedeeming` |
| issuance eligibility | ✅ 被抓到 | `Primary.staleScreeningMustBeRedone` |
| issuance escrow match | ✅ 被抓到 | `Primary.ineligibleInvestorsCannotSubscribe` |
| issuance minimum | ✅ 被抓到 | `Primary.amendedTermsSupersedeOldOnes` |
| issuance needs subscriber | ✅ 被抓到 | `Adversarial.oneLockBacksOneTrade` |
| issuance status | ✅ 被抓到 | `Primary.fundStatusGatesFlows` |
| jurisdiction | ✅ 被抓到 | `Primary.ineligibleInvestorsCannotSubscribe` |
| lock commits once | ✅ 被抓到 | `Adversarial.oneLockBacksOneTrade` |
| lock lapses at deadline | ✅ 被抓到 | `Secondary.takeRequiresAMatchingLock` |
| market halted | ✅ 被抓到 | `Adversarial.venueCannotEscapeTheRegulator` |
| market regulator co-sign | ✅ 被抓到 | `Adversarial.venueCannotEscapeTheRegulator` |
| maturity limit | ✅ 被抓到 | `Portfolio.eachLimitIsEnforced` |
| min redemption | ✅ 被抓到 | `Primary.redemptionPaysAtNavAndRetiresUnits` |
| nav agent identity | ✅ 被抓到 | `Primary.staleAttestationOrForeignNavBlocksRedemption` |
| nav freshness | ✅ 被抓到 | `Primary.staleAttestationOrNavBlocksIssuance` |
| non-positive value | ✅ 被抓到 | `Portfolio.eachLimitIsEnforced` |
| operator cannot override halt | ✅ 被抓到 | `Secondary.haltsStopSettlement` |
| order expiry | ✅ 被抓到 | `Secondary.takeRequiresAMatchingLock` |
| payout before lapse | ✅ 被抓到 | `Primary.subscriptionCashIsNeverStuck` |
| payout from custodian cash | ✅ 被抓到 | `Adversarial.redemptionIsPaidFromCustodyCash` |
| payout lapses | ✅ 被抓到 | `Adversarial.unpaidRedemptionLapsesToTheInvestor` |
| payout nav is current | ✅ 被抓到 | `Adversarial.stalePricedPayoutIsRefused` |
| payout needs owner | ✅ 被抓到 | `Primary.subscriptionCashIsNeverStuck` |
| payout screening | ✅ 被抓到 | `Adversarial.sanctionedRedeemerIsNotPaid` |
| portfolio breach gate | ✅ 被抓到 | `Portfolio.breachingPortfolioStopsSubscriptionsOnly` |
| price band | ✅ 被抓到 | `Secondary.priceBandAndSizeCap` |
| recall needs a legal order | ✅ 被抓到 | `Adversarial.escrowedUnitsCanBeRecalled` |
| recall order needs a legal order | ✅ 被抓到 | `Adversarial.escrowedUnitsCanBeRecalled` |
| recall payout needs a legal order | ✅ 被抓到 | `Adversarial.escrowedUnitsCanBeRecalled` |
| recall redemption needs a legal order | ✅ 被抓到 | `Adversarial.escrowedUnitsCanBeRecalled` |
| recall trade needs a legal order | ✅ 被抓到 | `Adversarial.escrowedUnitsCanBeRecalled` |
| recalled units are frozen | ✅ 被抓到 | `Adversarial.escrowedUnitsCanBeRecalled` |
| reclaim after lapse | ✅ 被抓到 | `Primary.subscriptionCashIsNeverStuck` |
| redeemer screening | ✅ 被抓到 | `Primary.redeemerMustBeScreened` |
| redemption attestation freshness | ✅ 被抓到 | `Primary.staleAttestationOrForeignNavBlocksRedemption` |
| redemption coverage | ✅ 被抓到 | `Primary.underReservedFundStopsIssuingAndRedeeming` |
| redemption needs custodian | ✅ 被抓到 | `Controls.noSinglePartyCanRewriteTheBook` |
| redemption pays cash | ✅ 被抓到 | `Controls.noSinglePartyCanRewriteTheBook` |
| redemption status | ✅ 被抓到 | `Primary.fundStatusGatesFlows` |
| register dual control | ✅ 被抓到 | `Adversarial.oneLockBacksOneTrade` |
| regulator halt lock | ✅ 被抓到 | `Secondary.haltsStopSettlement` |
| request matches escrow | ✅ 被抓到 | `Primary.ineligibleInvestorsCannotSubscribe` |
| reserve is sum of positions | ✅ 被抓到 | `Portfolio.reserveIsTheSumOfPositions` |
| screening age | ✅ 被抓到 | `Primary.staleScreeningMustBeRedone` |
| seize needs a legal order | ✅ 被抓到 | `Secondary.freezeAndSeizeUnderLegalOrder` |
| seller screening | ✅ 被抓到 | `Secondary.sanctionedSellerIsNotPaid` |
| settle checks market regulator | ✅ 被抓到 | `Adversarial.venueCannotEscapeTheRegulator` |
| settle deadline | ✅ 被抓到 | `Secondary.counterpartiesCanWalkAwayAfterTheDeadline` |
| size cap | ✅ 被抓到 | `Secondary.priceBandAndSizeCap` |
| take lock match | ✅ 被抓到 | `Secondary.takeRequiresAMatchingLock` |
| take pledges the lock | ✅ 被抓到 | `Adversarial.oneLockBacksOneTrade` |
| terms keep instrument | ✅ 被抓到 | `Primary.amendedTermsSupersedeOldOnes` |
| terms regulator co-sign | ✅ 被抓到 | `Primary.amendedTermsSupersedeOldOnes` |
| terms version bump | ✅ 被抓到 | `Primary.amendedTermsSupersedeOldOnes` |
| transfer receiver eligibility | ✅ 被抓到 | `Secondary.transfersNeedAnEligibleReceiver` |
| unit rounding down | ✅ 被抓到 | `Adversarial.oneLockBacksOneTrade` |
| venue can only tighten limits | ✅ 被抓到 | `Adversarial.venueCannotEscapeTheRegulator` |
| wal limit | ✅ 被抓到 | `Portfolio.breachingPortfolioStopsSubscriptionsOnly` |
| wam limit | ✅ 被抓到 | `Portfolio.breachingPortfolioStopsSubscriptionsOnly` |
| wam reset look-through | ✅ 被抓到 | `Portfolio.metricsFollowRule2a7Definitions` |
| weekly liquidity limit | ✅ 被抓到 | `Portfolio.eachLimitIsEnforced` |

**80／80 全部被抓到。** 重跑：`scripts/mutation_test.py`（需要 Docker，預設 3 路平行）；CI 每次用 `--check` 確認每個突變都還套得上目前的程式碼。
