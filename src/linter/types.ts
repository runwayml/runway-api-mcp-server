/** Scalar constraints extracted from one property of an OpenAPI request-body variant. */
export interface ParamConstraint {
  enum?: readonly (string | number)[];
  const?: string | number;
  type?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

/** Constraints for one model variant of an endpoint (one branch of the spec's oneOf). */
export interface ModelVariant {
  required: readonly string[];
  params: Readonly<Record<string, ParamConstraint>>;
}

/** All model variants for one Runway API endpoint. */
export interface EndpointConstraints {
  /** API path, e.g. "/v1/image_to_video". */
  path: string;
  models: Readonly<Record<string, ModelVariant>>;
}
