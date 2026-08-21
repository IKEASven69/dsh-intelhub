/** doctor / 面板共用的类型。 */

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
