export interface LoginCredentials {
  username: string;
  password: string;
}

export interface RegisterData {
  username: string;
  email: string;
  password: string;
  displayName: string;
}

export interface AuthResult {
  sessionId: string;
  user: { id: number; username: string; displayName: string; email: string };
}
