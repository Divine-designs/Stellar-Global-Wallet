// k6 load test: GET /api/v1/price/:asset (#122)
//
// Exercises the cached single-asset spot route. After the first request per
// 30 s TTL window this is served from the in-process price cache, so it
// mostly measures routing + cache + serialization. The batch route
// (GET /api/v1/price?assets=...) shares the same cache.
import http from "k6/http";
import { check } from "k6";
import { BASE_URL, TEST_ASSET, defaultScenarioOptions } from "./config.js";

// Lighter thresholds than the Horizon-backed endpoints: nearly every
// request is a cache hit, so it should be fast and should not fail.
export const options = defaultScenarioOptions({
  http_req_duration: ["p(50)<100", "p(95)<300"],
  http_req_failed: ["rate<0.01"],
});

export default function () {
  const res = http.get(`${BASE_URL}/api/v1/price/${TEST_ASSET}`);
  check(res, {
    "status is 200": (r) => r.status === 200,
  });
}
