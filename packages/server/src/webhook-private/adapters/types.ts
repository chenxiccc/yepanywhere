/**
 * 钉钉/飞书适配器统一接口 / Unified adapter interface for DingTalk/Feishu
 *
 * 每个适配器把平台无关的 WebhookPrivatePayload 转换成对应平台的请求
 * （URL、body、headers），并按平台规则计算签名。
 * Each adapter converts the platform-agnostic WebhookPrivatePayload into the
 * platform-specific request (URL, body, headers) and computes the signature
 * according to that platform's rules.
 */

import type { WebhookPrivatePayload } from "../types.js";

/** 平台标识 / Platform identifier */
export type AdapterPlatform = "dingtalk" | "feishu";

/** 适配器产出的 HTTP 请求 / HTTP request produced by an adapter */
export interface WebhookAdapterRequest {
  /** 最终请求 URL（钉钉会把签名拼到 query 上）/ Final request URL */
  url: string;
  /** JSON 请求体（飞书会把签名放到 body 顶层）/ JSON request body */
  body: unknown;
  /** 请求头 / Request headers */
  headers: Record<string, string>;
}

/** 适配器统一接口 / Unified adapter interface */
export interface WebhookAdapter {
  /** 平台标识 / Platform identifier */
  readonly platform: AdapterPlatform;
  /**
   * 把 payload 转换成对应平台请求并加签。
   * Convert payload into the platform-specific request and sign it.
   *
   * @param payload 平台无关中间表示 / Platform-agnostic payload
   * @param baseUrl 原始 webhook URL / Raw webhook URL
   * @param secret 加签密钥（可为空，表示不加签）/ Signing secret (empty = no signing)
   */
  buildRequest(
    payload: WebhookPrivatePayload,
    baseUrl: string,
    secret: string,
  ): Promise<WebhookAdapterRequest>;
}
