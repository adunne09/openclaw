---
summary: "CLI reference for `clawdbot sessions` (list stored sessions + send into a session)"
read_when:
  - You want to list stored sessions and see recent activity
---

# `clawdbot sessions`

List stored conversation sessions, or send a message into an existing session.

```bash
clawdbot sessions
clawdbot sessions --active 120
clawdbot sessions --json
```

## Send a message into a session

```bash
clawdbot sessions send --session "agent:webchat:direct:abc" --message "Hello"
clawdbot sessions send --session "agent:webchat:direct:abc" --message "Ping" --timeout 0
clawdbot sessions send --session "agent:webchat:direct:abc" --message "Ping" --json
```
