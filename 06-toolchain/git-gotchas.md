# Git 与代码托管平台的坑

> 三个坑，一个共同点：**git 给你的报错信息，指向的都不是真正的原因。**

## 一、全局 `url.insteadOf` 改写会让推送失败

### 现象

配置了国内加速镜像之后，从 GitHub 克隆变快了。但某天要往 GitHub 推送：

```
fatal: could not read Username for 'https://ghproxy.net': terminal prompts disabled
```

或者交互式环境下弹出一个**你没见过的域名**让你输密码 —— 输 GitHub 账号密码还不对。

### 根因

本机有这条全局配置：

```bash
# 查看
git config --global --get-regexp 'url\..*\.insteadof'
# 输出示例
url.https://some-mirror.example/https://github.com/.insteadof https://github.com/
```

它的语义是：**任何** `https://github.com/` 开头的地址，在 git 眼里都改写成镜像地址。

于是 `git push github master` 实际推的是 `https://some-mirror.example/https://github.com/user/repo.git`。

两个后果：

1. 镜像通常**只代理读操作**，推送不被支持
2. 凭据是按 host 记的，`github.com` 的凭据**不会**给 `some-mirror.example`，于是要求你输用户名

而 `gh auth setup-git` 这类工具只给 `github.com` 配了 credential helper，镜像域名拿不到。

### 做法

推送前临时拆掉改写，推完恢复：

```bash
# 1) 备份当前值
git config --global --get-regexp 'url\..*\.insteadof' > ~/insteadof.bak

# 2) 拆掉
git config --global --unset-all url."https://some-mirror.example/https://github.com/".insteadof

# 3) 推送（走真实 GitHub）
git push github master

# 4) 恢复（别忘，否则以后克隆变慢）
git config --global url."https://some-mirror.example/https://github.com/".insteadof "https://github.com/"
```

**更稳的做法**：给推送单独配一个不走改写的 remote。

```bash
git remote add github-push git@github.com:user/repo.git   # SSH 不受 https 改写影响
git push github-push master
```

> SSH 形式的地址完全不受 `url.https://...insteadof` 影响。如果配好了 SSH key，优先用 SSH 推送。

## 二、`--force-with-lease`：安全的强制覆盖

### 现象

想覆盖远端，`git push --force` 有效，但**很危险** —— 如果别人在这期间推过，你会直接抹掉他的提交，且没有任何提示。

### 做法

```bash
# 只当远端 master 仍指向 <旧hash> 时才允许覆盖
git push --force-with-lease=master:<旧hash> origin master
```

输出（成功）：

```
+ 9f6b431...9b790fd master -> master (forced update)
```

如果远端已经变了，会拒绝：

```
! [rejected] master -> master (stale info)
```

**为什么指定具体 hash 比 `--force-with-lease` 不带参数更安全**：不带参数时，git 用你的 `refs/remotes/origin/master` 做期望值 —— 而这个引用可能是**过期的**（你上次 fetch 之后的任何变化你都不知道）。指定 hash 是把你确认过的状态写死在命令里。

**流程**：

```bash
git fetch origin                                  # 先看远端到底在哪
git rev-parse origin/master                       # 记下 hash
# 确认这个 hash 是你要覆盖的那个
git push --force-with-lease=master:<那个hash> origin master
```

## 三、amend 之后，远端那个"别人的提交"可能就是你自己

### 现象

```
! [rejected]  master -> master (non-fast-forward)
```

`git rev-list --left-right --count master...origin/master` 显示 `1  1` —— 各有 1 个对方没有的提交。

于是判断："有人往远端推过，我得先合并。"

**很可能没人推过。** 那是你 `git commit --amend` 之前的版本。

### 根因

`amend` 不是"修改提交"，而是**创建一个新提交，旧提交变成孤儿**。旧的 hash 仍然存在（在 reflog 里），如果它曾在某个时刻被推送过，远端就有它。

时间线：

```
1. git commit            → 9f6b431
2. git push（成功）      → 远端 = 9f6b431
3. git commit --amend    → 本地 = 9b790fd，9f6b431 成为孤儿
4. git push             → rejected（远端 9f6b431 不在新提交的祖先链里）
```

### 做法：比对四个字段再下结论

```bash
# 本地还有这个对象吗
git cat-file -t 9f6b431        # → commit

# 看它到底是谁的提交
git log -1 --format="%H%n作者: %an <%ae>%n日期: %ad%n父提交: %P%n%s" 9f6b431

# 看本地 reflog 有没有对应记录
git reflog -6
```

如果四个字段（作者、时间戳、父提交、提交信息）与本地 reflog 里的 `HEAD@{n}` 完全一致 → **是你自己**，可以放心用 `--force-with-lease` 覆盖。

**反之**：作者不同、时间对不上、提交信息没见过 → 是真的别人的工作，**不要覆盖**，去合并或沟通。

### 附带一个报错

```bash
git rev-parse --short master origin/master github/master
# fatal: Needed a single revision
```

`rev-parse` 接受多个参数，但 `--short` 只对**单个** rev 生效。要逐个查：

```bash
for r in master origin/master github/master; do
  echo "$r = $(git rev-parse --short "$r")"
done
```

## 边界

- `insteadOf` 改写对 SSH 地址无效，所以"配好 SSH key"是从根上避免这类问题的办法。
- `--force-with-lease` 不能防"远端被强推覆盖"（别人的 force push 你不会知道）。团队协作应开启分支保护。
- amend 只能用于**尚未被他人基于其工作**的提交。已经在别人分支上被引用的提交，amend 会造成他们的历史断裂。
- reflog 是本地记录，**不会随 push 传到远端**。换机器后无法用它证明"那是我自己"。

## 一句话记法

> **推送报 rejected 时先问：远端那个 hash 我自己认得吗？用 `git log -1` 比作者和时间，比"猜"快得多。**
