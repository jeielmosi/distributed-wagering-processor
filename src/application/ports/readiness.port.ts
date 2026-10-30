export enum DependencyStatus {
  Up = 'UP',
  Down = 'DOWN'
}

export enum HealthStatus {
  Ok = 'OK',
  Error = 'ERROR'
}

export interface ReadinessResult {
  status: HealthStatus;
  checks: {
    postgres: DependencyStatus;
    sqs: DependencyStatus;
  };
}

export interface ReadinessPort {
  check(): Promise<ReadinessResult>;
}
