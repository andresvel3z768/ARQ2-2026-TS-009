local cjson = require "cjson.safe"
local RevocationHandler = { VERSION = "1.0.0", PRIORITY = 1400 }
local function decode_segment(segment)
  local value = segment:gsub("-", "+"):gsub("_", "/")
  local remainder = #value % 4
  if remainder > 0 then value = value .. string.rep("=", 4 - remainder) end
  return ngx.decode_base64(value)
end
function RevocationHandler:access(conf)
  local header = kong.request.get_header("authorization")
  if not header then return kong.response.exit(401, { error = "UNAUTHORIZED" }) end
  local token = header:match("^[Bb]earer%s+(.+)$")
  if not token then return kong.response.exit(401, { error = "UNAUTHORIZED" }) end
  local _, payload = token:match("^([^.]+)%.([^.]+)%.")
  if not payload then return kong.response.exit(401, { error = "INVALID_TOKEN" }) end
  local decoded = decode_segment(payload)
  local claims = decoded and cjson.decode(decoded)
  if not claims or not claims.jti then return kong.response.exit(401, { error = "INVALID_TOKEN" }) end
  local red = require("resty.redis"):new()
  red:set_timeout(1000)
  local ok = red:connect(conf.redis_host, conf.redis_port)
  if not ok then return kong.response.exit(503, { error = "REVOCATION_STORE_UNAVAILABLE" }) end
  local revoked = red:get("revoked:" .. claims.jti)
  red:close()
  if revoked and revoked ~= ngx.null then return kong.response.exit(401, { error = "TOKEN_REVOKED" }) end
end
return RevocationHandler
