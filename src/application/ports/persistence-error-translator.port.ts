export interface PersistenceErrorTranslatorPort {
  translate(error: unknown): unknown;
}
