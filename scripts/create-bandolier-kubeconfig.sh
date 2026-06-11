#!/usr/bin/env bash
# Create a self-contained, server-usable kubeconfig for Bandolier.
#
# Bandolier runs the Kubernetes client on its server (e.g. Vercel), so it cannot
# use kubeconfigs that shell out to a CLI (the `aws`/`gcloud` exec credential
# plugins) or that reference cert/key files on your laptop — the server has
# neither those binaries nor those files. This script provisions a ServiceAccount
# with a long-lived token in your CURRENT cluster and prints a kubeconfig that
# authenticates with that token: no external commands, all credentials inline.
#
# Paste the output into Bandolier → Settings → Kubeconfig.
#
# Usage:
#   ./scripts/create-bandolier-kubeconfig.sh [options]
#
# Options:
#   -n, --name NAME       ServiceAccount name           (default: bandolier)
#   -s, --namespace NS    ServiceAccount namespace      (default: kube-system)
#   -c, --context CTX     kubectl context to target     (default: current context)
#   -o, --output FILE     Write kubeconfig to FILE       (default: stdout)
#       --scoped          Bind a least-privilege ClusterRole (create namespaces,
#                         jobs, secrets, serviceaccounts, networkpolicies; read
#                         pods/logs) instead of cluster-admin
#   -h, --help            Show this help and exit
#
# Requires: kubectl with admin access to the target cluster, and `base64`.
set -euo pipefail

SA_NAME="bandolier"
NAMESPACE="kube-system"
CONTEXT=""
OUTPUT=""
SCOPED=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--name)      SA_NAME="$2"; shift 2 ;;
    -s|--namespace) NAMESPACE="$2"; shift 2 ;;
    -c|--context)   CONTEXT="$2"; shift 2 ;;
    -o|--output)    OUTPUT="$2"; shift 2 ;;
    --scoped)       SCOPED=1; shift ;;
    -h|--help)      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; s/^set -euo.*//'; exit 0 ;;
    *) echo "error: unknown option '$1' (try --help)" >&2; exit 1 ;;
  esac
done

KUBECTL=(kubectl)
[[ -n "$CONTEXT" ]] && KUBECTL+=(--context "$CONTEXT")

# Resolve the API server endpoint of the active context.
SERVER="$("${KUBECTL[@]}" config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
[[ -n "$SERVER" ]] || { echo "error: could not determine the cluster API server from kubeconfig" >&2; exit 1; }

case "$SERVER" in
  *127.0.0.1*|*localhost*)
    echo "warning: API server is ${SERVER} — a hosted Bandolier server cannot reach a localhost endpoint." >&2 ;;
esac

echo "Provisioning ServiceAccount '${NAMESPACE}/${SA_NAME}' on ${SERVER}" >&2

# 1) ServiceAccount.
"${KUBECTL[@]}" apply -f - >&2 <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${SA_NAME}
  namespace: ${NAMESPACE}
EOF

# 2) RBAC: cluster-admin by default, or a scoped ClusterRole with --scoped.
if [[ "$SCOPED" == "1" ]]; then
  "${KUBECTL[@]}" apply -f - >&2 <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${SA_NAME}
rules:
- apiGroups: [""]
  resources: ["namespaces", "serviceaccounts", "secrets"]
  verbs: ["get", "list", "create"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "delete", "patch"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get"]
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["get", "list", "create", "delete", "patch"]
- apiGroups: ["networking.k8s.io"]
  resources: ["networkpolicies"]
  verbs: ["get", "list", "create"]
EOF
  ROLE_KIND="ClusterRole"
  ROLE_NAME="${SA_NAME}"
else
  ROLE_KIND="ClusterRole"
  ROLE_NAME="cluster-admin"
fi

"${KUBECTL[@]}" apply -f - >&2 <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${SA_NAME}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ${ROLE_KIND}
  name: ${ROLE_NAME}
subjects:
- kind: ServiceAccount
  name: ${SA_NAME}
  namespace: ${NAMESPACE}
EOF

# 3) Long-lived token Secret (Kubernetes 1.24+ no longer auto-creates one).
SECRET_NAME="${SA_NAME}-token"
"${KUBECTL[@]}" apply -f - >&2 <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_NAME}
  namespace: ${NAMESPACE}
  annotations:
    kubernetes.io/service-account.name: ${SA_NAME}
type: kubernetes.io/service-account-token
EOF

# Wait for the token controller to populate the Secret.
echo "Waiting for the token to be issued..." >&2
TOKEN_B64=""
for _ in $(seq 1 30); do
  TOKEN_B64="$("${KUBECTL[@]}" get secret "$SECRET_NAME" -n "$NAMESPACE" -o jsonpath='{.data.token}' 2>/dev/null || true)"
  [[ -n "$TOKEN_B64" ]] && break
  sleep 1
done
[[ -n "$TOKEN_B64" ]] || { echo "error: token was not populated within 30s" >&2; exit 1; }

CA_B64="$("${KUBECTL[@]}" get secret "$SECRET_NAME" -n "$NAMESPACE" -o jsonpath='{.data.ca\.crt}')"
TOKEN="$(printf '%s' "$TOKEN_B64" | base64 -d)"

# `certificate-authority-data` wants base64-encoded PEM, which is exactly what
# the Secret stores; the token must be the decoded JWT.
read -r -d '' KUBECONFIG <<EOF || true
apiVersion: v1
kind: Config
clusters:
- name: ${SA_NAME}
  cluster:
    server: ${SERVER}
    certificate-authority-data: ${CA_B64}
users:
- name: ${SA_NAME}
  user:
    token: ${TOKEN}
contexts:
- name: ${SA_NAME}
  context:
    cluster: ${SA_NAME}
    user: ${SA_NAME}
current-context: ${SA_NAME}
EOF

if [[ -n "$OUTPUT" ]]; then
  printf '%s\n' "$KUBECONFIG" > "$OUTPUT"
  echo "Wrote kubeconfig to ${OUTPUT}" >&2
else
  echo "----- paste everything below into Bandolier → Settings → Kubeconfig -----" >&2
  printf '%s\n' "$KUBECONFIG"
fi
