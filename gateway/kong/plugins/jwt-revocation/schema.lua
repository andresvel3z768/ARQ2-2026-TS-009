return {
  name = "jwt-revocation",
  fields = {
    { config = {
      type = "record",
      fields = {
        { redis_host = { type = "string", required = true, default = "valkey" } },
        { redis_port = { type = "integer", required = true, default = 6379 } }
      }
    } }
  }
}
