{{/*
Expand the name of the chart.
*/}}
{{- define "bandolier.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name, capped at 63 chars for label/DNS limits.
*/}}
{{- define "bandolier.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "bandolier.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every resource.
*/}}
{{- define "bandolier.labels" -}}
helm.sh/chart: {{ include "bandolier.chart" . }}
{{ include "bandolier.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels — the stable subset used to match pods.
*/}}
{{- define "bandolier.selectorLabels" -}}
app.kubernetes.io/name: {{ include "bandolier.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
The ServiceAccount name to use.
*/}}
{{- define "bandolier.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "bandolier.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the app-config Secret in use (created or externally provided).
*/}}
{{- define "bandolier.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "bandolier.fullname" . }}
{{- end }}
{{- end }}

{{/*
Bundled-Postgres resource name.
*/}}
{{- define "bandolier.postgres.fullname" -}}
{{- printf "%s-postgres" (include "bandolier.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
True when Postgres is deployed by this chart (any mode but external).
*/}}
{{- define "bandolier.postgres.deployed" -}}
{{- if or (eq .Values.postgres.mode "bundled") (eq .Values.postgres.mode "cnpg") }}true{{ end }}
{{- end }}

{{/*
Host of the in-cluster Postgres for the active mode. CloudNativePG exposes the
primary at "<cluster>-rw"; the bundled StatefulSet uses its headless service.
*/}}
{{- define "bandolier.postgres.host" -}}
{{- if eq .Values.postgres.mode "cnpg" }}
{{- printf "%s-rw" (include "bandolier.postgres.fullname" .) }}
{{- else }}
{{- include "bandolier.postgres.fullname" . }}
{{- end }}
{{- end }}

{{/*
The effective DATABASE_URL. For a chart-deployed database (bundled/cnpg) derive
it from the active mode's host + auth; otherwise use the provided value.
*/}}
{{- define "bandolier.databaseUrl" -}}
{{- if include "bandolier.postgres.deployed" . }}
{{- $a := .Values.postgres.auth }}
{{- printf "postgresql://%s:%s@%s:5432/%s" $a.username $a.password (include "bandolier.postgres.host" .) $a.database }}
{{- else }}
{{- .Values.secrets.databaseUrl }}
{{- end }}
{{- end }}

{{/*
Bundled-MinIO resource name.
*/}}
{{- define "bandolier.minio.fullname" -}}
{{- printf "%s-minio" (include "bandolier.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Validate configuration and fail the render early with an actionable message.
*/}}
{{- define "bandolier.validate" -}}
{{- $mode := .Values.postgres.mode }}
{{- if not (has $mode (list "external" "bundled" "cnpg")) }}
{{- fail (printf "postgres.mode must be one of external|bundled|cnpg, got %q." $mode) }}
{{- end }}
{{- if eq $mode "external" }}
{{- if and .Values.secrets.create (not .Values.secrets.databaseUrl) }}
{{- fail "secrets.databaseUrl is required when postgres.mode=external. Either point it at an external database, or set postgres.mode=bundled|cnpg to deploy one." }}
{{- end }}
{{- end }}
{{- if .Values.secrets.create }}
{{- if not .Values.secrets.betterAuthSecret }}
{{- fail "secrets.betterAuthSecret is required (generate one with: openssl rand -base64 32). Set secrets.create=false to supply your own Secret instead." }}
{{- end }}
{{- if or (not .Values.secrets.githubClientId) (not .Values.secrets.githubClientSecret) }}
{{- fail "secrets.githubClientId and secrets.githubClientSecret are required (from your GitHub OAuth app)." }}
{{- end }}
{{- end }}
{{- end }}
