# 合并指南：session-cache-indexeddb → 上游 main

本文档说明 `mine/session-cache-indexeddb` 分支（会话缓存优化）如何合并到上游 main 的最新版本。

## 分支概况

| 项目 | 内容 |
|------|------|
| 目标 | 加速远程（Cloudflare Tunnel）重开对话：IndexedDB 缓存消息尾部 + gzip + 锚点增量 |
| 基点 | main（含若干上游 merge） |
| 改动文件 | 19 个，新增 3 个（sessionCache/ 模块），修改 16 个 |
| 冲突风险 | 中（3 个上游热文件有侵入式改动） |

## 改动文件分类与合并策略

### A. 零冲突（新增文件，直接保留）

这些文件上游不存在，合并时无冲突：

| 文件 | 说明 |
|------|------|
| `packages/client/src/lib/sessionCache/sessionCacheDb.ts` | IndexedDB 底层（open/put/get/trim/LRU） |
| `packages/client/src/lib/sessionCache/sessionCacheEntry.ts` | 缓存条目类型 + size 估算 |
| `packages/client/src/lib/sessionCache/sessionCacheStore.ts` | adapter 接口 + createSessionCacheAdapter 单例 |
| `packages/client/src/hooks/__tests__/useSessionMessages.cache.test.tsx` | 缓存单元测试 |
| `packages/server/test/compress.test.ts` | gzip 测试（属 A 分支，若一并合并） |

**策略**：直接保留，无需处理。

### B. 低冲突（末尾追加，已用 [ya-private] 标记）

这些改动都在文件末尾或末尾区域，上游在中间加内容不会冲突：

| 文件 | 改动 | 合并策略 |
|------|------|----------|
| `packages/server/src/services/ServerSettingsService.ts` | `sessionLoadCacheEnabled` 字段加在接口/DEFAULT 末尾 | 保留末尾的 [ya-private] 块 |
| `packages/server/src/routes/settings.ts` | PUT allowlist 末尾加 sessionLoadCacheEnabled | 保留末尾的 [ya-private] 块 |
| `packages/client/src/api/client.ts` | ServerSettings 接口末尾加字段 | 保留末尾 |
| `packages/client/src/types.ts` | AgentContent/AgentContentMap 迁移至此（末尾） | 保留末尾 |
| `packages/client/src/i18n/*.json`（6 个） | sessionLoadCache* key 移到文件末尾 | 保留末尾 |
| `packages/client/src/pages/settings/RemoteAccessSettings.tsx` | 末尾加 toggle + 清除按钮 | 保留末尾 [ya-private] 块 |

**策略**：合并时如果冲突，把我们的 [ya-private] 块重新放到末尾即可。

### C. 中冲突（上游热文件，侵入式改动）

这 3 个文件上游频繁修改，合并时大概率冲突：

#### C1. `packages/client/src/hooks/useSessionMessages.ts`（最高风险）

**我们的改动**（初始加载 effect 重写）：
- options 加 `cacheAdapter?: SessionCacheAdapter`
- `cacheAdapterRef`（节流写用）+ `sessionRef`/`paginationRef`（卸载 flush 用）
- 初始加载 effect：`hydrationPromise = cacheAdapter.read().then(...)` → REST → 锚点校验（pagination 有无）→ 合并/冷载
- `fetchNewMessages` 加 `initialLoadCompleteRef` guard
- 节流写 effect（2s debounce）+ 卸载 flush
- 所有 [ya-private] 标记的块

**上游热区**：
- 初始加载 effect（`useEffect` 依赖数组、加载逻辑）
- `fetchNewMessages`
- stream 消息处理（`handleStreamMessageEvent`）

**合并策略**：
1. 先接受上游版本（theirs），然后手动重新应用我们的 [ya-private] 块
2. 关键：effect 的依赖数组里加 `cacheAdapter`；effect 内 hydrate→REST→校验链要保持
3. `fetchNewMessages` 开头的 `if (!initialLoadCompleteRef.current) return Promise.resolve()` 要保留
4. 节流写 effect（`[messages, session, pagination]` deps）独立于初始加载 effect，不与上游冲突
5. 测试：合并后跑 `useSessionMessages.cache.test.tsx`，11 个用例全过才算正确

#### C2. `packages/client/src/hooks/useServerSettings.ts`（中风险）

**我们的改动**：
- 模块级 `let cachedSettings` + `readCachedSettings()`/`writeCachedSettings()`（localStorage 持久化）
- `useState` 初始值用 `cachedSettings`（非 null）
- `fetchSettings`/`updateSettings` 调 `writeCachedSettings`
- **TDZ 注意**：`let cachedSettings` 必须在 `readCachedSettings()` 调用之前声明

**上游可能加的**：
- `useBackgroundRevalidation`（已在 main 上，merge 时会进来）
- 新的 settings 字段

**合并策略**：
1. 保留我们的 `cachedSettings`/`readCachedSettings`/`writeCachedSettings` 三个函数 + `let` 声明（顺序：let → 赋值 → 函数定义）
2. 上游的 `useBackgroundRevalidation` 保留，但其 `apply` 回调里加 `writeCachedSettings(next)`（否则后台刷新不更新 localStorage）
3. **TDZ 红线**：`let cachedSettings: ServerSettings | null = null` 必须在 `cachedSettings = readCachedSettings()` 之前，两者都在函数定义之前

#### C3. `packages/client/src/pages/SessionPage.tsx`（中风险）

**我们的改动**：
- `useServerSettings()` 调用 + `sessionLoadCacheEnabled` 计算
- `clientTailParams` useMemo 里加 `cacheAdapter: createSessionCacheAdapter(sessionLoadCacheEnabled)`
- 透传给 `useSession`

**上游热区**：
- `SessionPageContent` 内 hook 调用顺序
- `clientTailParams` 的 useMemo

**合并策略**：
1. 保留我们的 [ya-private] 块（useServerSettings + cacheAdapter 透传）
2. 如果上游改了 `clientTailParams` 的结构，把 `cacheAdapter` 字段加回去
3. 确保 `useSession(...)` 的 options 里有 `cacheAdapter`

### D. 小冲突（透传链）

| 文件 | 改动 | 策略 |
|------|------|------|
| `packages/client/src/hooks/useSession.ts` | options 加 `cacheAdapter`，透传给 useSessionMessages | 保留 [ya-private] 标记行 |

## 合并步骤（推荐）

```
# 1. 基于最新 main 新建分支
git checkout main && git pull upstream main
git checkout -b mine/session-cache-indexeddb-v2

# 2. 逐文件 cherry-pick 或手动应用
# 零冲突文件直接 cherry-pick
git checkout mine/session-cache-indexeddb -- packages/client/src/lib/sessionCache/

# 3. 低冲突文件用 merge（末尾追加，冲突易解）
git checkout mine/session-cache-indexeddb -- packages/client/src/i18n/ packages/client/src/types.ts packages/client/src/api/client.ts packages/server/src/services/ServerSettingsService.ts packages/server/src/routes/settings.ts packages/client/src/pages/settings/RemoteAccessSettings.tsx

# 4. 中冲突文件手动处理（C1/C2/C3）
#    先看上游版本，再手动加回 [ya-private] 块
#    重点：useSessionMessages.ts 的 effect 链 + fetchNewMessages guard + 节流写
#    重点：useServerSettings.ts 的 TDZ 顺序
#    重点：SessionPage.tsx 的 cacheAdapter 透传

# 5. 验证
pnpm typecheck
pnpm --filter @yep-anywhere/client exec vitest run src/hooks/__tests__/useSessionMessages.cache.test.tsx
# 11 个用例全过 = 合并正确
```

## 验证清单

- [ ] `pnpm typecheck` 无错误
- [ ] `useSessionMessages.cache.test.tsx` 11/11 通过
- [ ] `useServerSettings.ts` 无 TDZ（`let cachedSettings` 在 `readCachedSettings()` 之前）
- [ ] `useSessionMessages.ts` 的 `fetchNewMessages` 有 `initialLoadCompleteRef` guard
- [ ] `useSessionMessages.ts` 的 effect deps 含 `cacheAdapter`
- [ ] `SessionPage.tsx` 的 `clientTailParams` 含 `cacheAdapter`
- [ ] `useSession.ts` 的 options 透传 `cacheAdapter`
- [ ] i18n 6 个文件的 sessionLoadCache* key 在末尾
- [ ] 设置页有 toggle + 清除缓存按钮
- [ ] 生产构建（`pnpm build:bundle`）无白屏

## 关键设计决策（合并时必须保留）

1. **adapter 单例**：`createSessionCacheAdapter` 返回模块级单例（NOOP/REAL），引用稳定，只在 settings 翻转时变一次
2. **锚点校验**：用 `data.pagination !== undefined` 判断锚点 miss（非 count 变化），运行中对话走增量
3. **fetchNewMessages guard**：`initialLoadCompleteRef` 防止 connected 事件在加载期发冗余全量
4. **节流写**：2s debounce + 卸载 flush，缓存保鲜
5. **settings 持久化**：localStorage 存 settings，刷新/重开 PWA 后首帧 adapter=REAL
6. **TDZ**：`let cachedSettings` 必须在 `readCachedSettings()` 调用之前声明
