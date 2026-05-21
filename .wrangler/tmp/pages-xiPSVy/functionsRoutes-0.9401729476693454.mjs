import { onRequestOptions as __api_translate_ts_onRequestOptions } from "/home/pyo9292/warmer/functions/api/translate.ts"
import { onRequestPost as __api_translate_ts_onRequestPost } from "/home/pyo9292/warmer/functions/api/translate.ts"

export const routes = [
    {
      routePath: "/api/translate",
      mountPath: "/api",
      method: "OPTIONS",
      middlewares: [],
      modules: [__api_translate_ts_onRequestOptions],
    },
  {
      routePath: "/api/translate",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_translate_ts_onRequestPost],
    },
  ]