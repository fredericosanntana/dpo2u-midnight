export interface DeployedAddresses {
  ComplianceRegistry?: string;
  PaymentGateway?: string;
  FeeDistributor?: string;
  AgentRegistry?: string;
  HealthDIDRegistry?: string;
  HealthConsentRegistry?: string;
  CuidaBotCompliance?: string;
}

export function padTo32Bytes(str: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(str, 'utf-8').copy(buf, 0, 0, Math.min(str.length, 32));
  return new Uint8Array(buf);
}

export function bytesToString(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf-8').replace(/\0+$/, '');
}
