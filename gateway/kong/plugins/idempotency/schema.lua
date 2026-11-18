return {
  name = "idempotency",
  fields = {
    { config = {
      type = "record",
      fields = {
        { redis_host = { type = "string", required = true, default = "valkey" } },
        { redis_port = { type = "integer", required = true, default = 6379 } },
        { ttl = { type = "integer", required = true, default = 86400 } },
        { required_paths = { type = "array", elements = { type = "string" }, default = { "/v1/bookings" } } }
      }
    } }
  }
}
