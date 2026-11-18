local IdempotencyHandler = {
  VERSION = "1.0.0",
  PRIORITY = 900
}
function IdempotencyHandler:access(conf)
  local path = kong.request.get_path()
  local required = false
  for _, p in ipairs(conf.required_paths or {}) do if path == p then required = true end end
  if not required then return end
  local key = kong.request.get_header("Idempotency-Key")
  if not key or not key:match("^[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]%-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]%-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]%-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]%-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]$") then
    return kong.response.exit(400, { error = "IDEMPOTENCY_KEY_REQUIRED", message = "Provide a valid Idempotency-Key header" })
  end
  local red = require("resty.redis"):new()
  red:set_timeout(1000)
  local ok = red:connect(conf.redis_host, conf.redis_port)
  if not ok then return kong.response.exit(503, { error = "IDEMPOTENCY_STORE_UNAVAILABLE" }) end
  local consumer = kong.client.get_consumer()
  local agency = consumer and (consumer.custom_id or consumer.username) or "anonymous"
  local result, err = red:set("idem:" .. agency .. ":" .. key, "IN_PROGRESS", "NX", "EX", conf.ttl)
  if err then red:close(); return kong.response.exit(503, { error = "IDEMPOTENCY_STORE_ERROR" }) end
  if result ~= "OK" then kong.ctx.shared.idempotency_replay = true end
  red:close()
end
return IdempotencyHandler
