# slack-claude

Claude Code용 커스텀 Slack MCP 서버 — PULL 방식 + 파일 업로드 지원

## 왜 커스텀 MCP인가?

공식 `claude.ai Slack MCP`는 메시지 읽기와 텍스트 전송만 지원합니다.
이 커스텀 서버는 `mcpServers`를 통해 `settings.json`에 직접 등록되어 다음을 추가로 제공합니다:

- **PULL 방식 폴링** — `get_messages` 툴로 Claude가 능동적으로 메시지를 가져옵니다
- **파일 업로드** — 이미지, 문서 등을 Slack 채널에 직접 업로드
- **채널 접근 제어** — allowlist 기반으로 허용 채널을 관리

## 아키텍처

```
Slack Bot API (@slack/web-api)
  → 30초마다 허용 채널 폴링
  → 인바운드 메시지를 메모리 큐에 저장
  → Claude가 get_messages 툴로 큐에서 가져감
  → Claude가 send_message / send_file 툴로 응답
```

MCP 통신 방식: **stdio** (Bun으로 실행)

## 제공 툴

| 툴 | 설명 |
|----|------|
| `get_messages` | 큐에 쌓인 새 메시지를 가져와 큐를 비움 |
| `send_message` | 채널 또는 DM에 텍스트 전송 (스레드 지원) |
| `send_file` | 파일(이미지/문서, 최대 50MB) 업로드 |
| `get_bot_info` | 봇 상태, 허용 채널 목록 확인 |
| `add_channel` | 폴링 allowlist에 채널 추가 |

## 설치

### 사전 준비

- [Claude Code](https://claude.ai/code) 설치
- [Bun](https://bun.sh) 설치 (`curl -fsSL https://bun.sh/install | bash`)

### 새 기기 한 번에 설치

```bash
curl -fsSL https://raw.githubusercontent.com/jyp90/slack-claude-session/main/install-new-device.sh | bash
```

또는 클론 후:

```bash
git clone https://github.com/jyp90/slack-claude-session.git
cd slack-claude-session
./install-new-device.sh
```

### 수동 설치

1. **의존성 설치**

```bash
bun install
```

2. **봇 토큰 설정**

```bash
mkdir -p ~/.claude/channels/slack
echo "SLACK_BOT_TOKEN=xoxb-..." > ~/.claude/channels/slack/.env
chmod 600 ~/.claude/channels/slack/.env
```

Slack Bot Token 발급: [api.slack.com/apps](https://api.slack.com/apps) → OAuth & Permissions

필요한 Bot Token Scopes:
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `chat:write`, `files:write`, `users:read`

3. **MCP 등록**

```bash
claude mcp add slack-claude --scope user -- $(which bun) /path/to/slack-claude-session/server.ts
```

## 설정 파일

| 파일 | 내용 |
|------|------|
| `~/.claude/channels/slack/.env` | `SLACK_BOT_TOKEN=xoxb-...` |
| `~/.claude/channels/slack/config.json` | 허용 채널 목록 (`allowChannels`) |

`config.json` 예시:

```json
{
  "allowChannels": ["C0123456789", "C9876543210"],
  "botUserId": "U0123456789"
}
```

## 사용 예시

Claude Code 세션에서:

```
/loop 1m get_messages 툴 호출해서 새 슬랙 메시지 있으면 답장해줘
```

채널 추가:

```
add_channel 툴로 C0123456789 채널 등록해줘
```

## 라이선스

MIT
