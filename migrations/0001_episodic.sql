CREATE TABLE IF NOT EXISTS honi_messages (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_honi_messages_thread ON honi_messages(agent_name, thread_id, created_at);
