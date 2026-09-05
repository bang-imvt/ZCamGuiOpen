export type CameraCandidate = {
  id: string;
  name: string;
  host: string;
  address: string;
  port: 80;
  serviceType: '_eagle._tcp';
  servicePort: number;
  txt: Record<string, string>;
  reachable: boolean;
  probeError?: string;
  info?: unknown;
};

export type CameraCredentials = {
  username: string;
  password: string;
};

export type CameraEvent = {
  type: string;
  payload: Record<string, unknown>;
};
