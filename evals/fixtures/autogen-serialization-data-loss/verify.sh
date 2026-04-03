#!/usr/bin/env bash
set -euo pipefail

cd python/packages/autogen-agentchat

# Activate venv
source .venv/bin/activate 2>/dev/null || true
export PATH=".venv/bin:$PATH"

# Run a quick inline verification that subclass fields survive serialization
python3 -c "
import json
from autogen_agentchat.messages import TextMessage
from autogen_agentchat.teams._group_chat._events import GroupChatMessage, GroupChatStart

# Test 1: GroupChatMessage preserves TextMessage fields
text_msg = TextMessage(content='Hello, world!', source='TestAgent')
group_msg = GroupChatMessage(message=text_msg)
parsed = json.loads(group_msg.model_dump_json())
assert 'content' in parsed['message'], f'content missing from GroupChatMessage serialization: {parsed}'
assert parsed['message']['content'] == 'Hello, world!', f'content mismatch: {parsed}'
assert 'type' in parsed['message'], f'type missing from GroupChatMessage serialization: {parsed}'
print('PASS: GroupChatMessage preserves subclass fields')

# Test 2: GroupChatStart preserves message list fields
start = GroupChatStart(messages=[text_msg])
parsed = json.loads(start.model_dump_json())
assert 'content' in parsed['messages'][0], f'content missing from GroupChatStart: {parsed}'
assert parsed['messages'][0]['content'] == 'Hello, world!', f'content mismatch: {parsed}'
print('PASS: GroupChatStart preserves subclass fields in list')

# Test 3: TaskResult preserves messages
from autogen_agentchat.base import TaskResult, Response
result = TaskResult(messages=[text_msg])
parsed = json.loads(result.model_dump_json())
assert 'content' in parsed['messages'][0], f'content missing from TaskResult: {parsed}'
print('PASS: TaskResult preserves subclass fields')

# Test 4: Response preserves chat_message
response = Response(chat_message=text_msg, inner_messages=[text_msg])
from autogen_agentchat.teams._group_chat._events import GroupChatAgentResponse
agent_resp = GroupChatAgentResponse(response=response, name='TestAgent')
parsed = json.loads(agent_resp.model_dump_json())
assert 'content' in parsed['response']['chat_message'], f'content missing from Response: {parsed}'
assert 'content' in parsed['response']['inner_messages'][0], f'content missing from inner_messages: {parsed}'
print('PASS: GroupChatAgentResponse preserves nested subclass fields')

print()
print('All 4 tests passed.')
"
