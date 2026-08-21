/** doctor / 面板共用的类型。 */

export interface DoctorRequest {
  /** 预留：目前无参数；保留对象签名以符合 RPC 网关 SRC 校验规则。 */
}

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
  storePath: string
  storeExists: boolean | null
  modelNote: string
  guidance: string[]
}
