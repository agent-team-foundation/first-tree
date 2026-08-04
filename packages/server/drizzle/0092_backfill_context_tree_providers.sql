WITH eligible_bindings AS (
	SELECT
		settings.organization_id,
		settings.value,
		settings.version AS source_version,
		settings.value ->> 'repo' AS repo,
		settings.value ->> 'branch' AS branch,
		connection.instance_origin
	FROM organization_settings AS settings
	LEFT JOIN gitlab_connections AS connection
		ON connection.organization_id = settings.organization_id
	WHERE settings.namespace = 'context_tree'
		AND jsonb_typeof(settings.value) = 'object'
		AND jsonb_typeof(settings.value -> 'repo') = 'string'
		AND NOT settings.value ? 'provider'
), parsed_bindings AS (
	SELECT
		organization_id,
		value,
		source_version,
		repo,
		branch,
		regexp_match(
			repo,
			'(?i)^https://([A-Za-z0-9._-]+)(?::([0-9]+))?/([A-Za-z0-9_-][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*)$'
		) AS https_parts,
		regexp_match(
			repo,
			'(?i)^ssh://(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9._-]+)(?::([0-9]+))?/([A-Za-z0-9_-][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*)$'
		) AS ssh_parts,
		regexp_match(
			repo,
			'(?i)^(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9._-]+):((?![0-9]+(?:/|$))[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*)$'
		) AS scp_parts,
		regexp_match(
			instance_origin,
			'(?i)^https://([A-Za-z0-9._-]+)(?::([0-9]+))?/?$'
		) AS connection_parts
	FROM eligible_bindings
), normalized_bindings AS (
	SELECT
		organization_id,
		value,
		source_version,
		repo,
		branch,
		https_parts,
		ssh_parts,
		scp_parts,
		connection_parts,
		CASE
			WHEN https_parts[2] IS NULL THEN NULL
			WHEN length(ltrim(https_parts[2], '0')) <= 5
				THEN COALESCE(NULLIF(ltrim(https_parts[2], '0'), ''), '0')::integer
			ELSE 65536
		END AS https_port,
		CASE
			WHEN ssh_parts[2] IS NULL THEN NULL
			WHEN length(ltrim(ssh_parts[2], '0')) <= 5
				THEN COALESCE(NULLIF(ltrim(ssh_parts[2], '0'), ''), '0')::integer
			ELSE 65536
		END AS ssh_port,
		CASE
			WHEN connection_parts[2] IS NULL THEN NULL
			WHEN length(ltrim(connection_parts[2], '0')) <= 5
				THEN COALESCE(NULLIF(ltrim(connection_parts[2], '0'), ''), '0')::integer
			ELSE 65536
		END AS connection_port,
		CASE
			WHEN NOT value ? 'branch' THEN true
			WHEN jsonb_typeof(value -> 'branch') <> 'string' THEN false
			ELSE
				branch <> ''
				AND branch = btrim(branch)
				AND branch !~ '[[:space:][:cntrl:]]'
				AND branch <> 'HEAD'
				AND left(branch, 1) NOT IN ('-', '/')
				AND right(branch, 1) NOT IN ('/', '.')
				AND position('//' IN branch) = 0
				AND position('..' IN branch) = 0
				AND position('@{' IN branch) = 0
				AND position('~' IN branch) = 0
				AND position('^' IN branch) = 0
				AND position(':' IN branch) = 0
				AND position('?' IN branch) = 0
				AND position('*' IN branch) = 0
				AND position('[' IN branch) = 0
				AND position(E'\\' IN branch) = 0
				AND branch !~ '(^|/)[.]'
				AND branch !~ '[.]lock(/|$)'
		END AS branch_valid
	FROM parsed_bindings
), provider_candidates AS (
	SELECT
		organization_id,
		value AS source_value,
		source_version,
		CASE
			WHEN
				branch_valid
				AND (
					(lower(https_parts[1]) = 'github.com' AND https_parts[2] IS NULL)
					OR (
						lower(ssh_parts[1]) = 'github.com'
						AND (ssh_parts[2] IS NULL OR ssh_port BETWEEN 0 AND 65535)
					)
					OR lower(scp_parts[1]) = 'github.com'
				)
			THEN 'github'
			WHEN
				branch_valid
				AND connection_parts IS NOT NULL
				AND (connection_parts[2] IS NULL OR connection_port BETWEEN 0 AND 65535)
				AND (
					(
						https_parts IS NOT NULL
						AND lower(https_parts[1]) <> 'github.com'
						AND (https_parts[2] IS NULL OR https_port BETWEEN 0 AND 65535)
						AND lower(https_parts[1]) = lower(connection_parts[1])
						AND COALESCE(https_port, 443) = COALESCE(connection_port, 443)
					)
					OR (
						ssh_parts IS NOT NULL
						AND lower(ssh_parts[1]) <> 'github.com'
						AND (ssh_parts[2] IS NULL OR ssh_port BETWEEN 0 AND 65535)
						AND lower(ssh_parts[1]) = lower(connection_parts[1])
					)
					OR (
						scp_parts IS NOT NULL
						AND lower(scp_parts[1]) <> 'github.com'
						AND lower(scp_parts[1]) = lower(connection_parts[1])
					)
				)
			THEN 'gitlab'
			ELSE NULL
		END AS provider
	FROM normalized_bindings
)
UPDATE organization_settings AS settings
SET
	value = jsonb_set(settings.value, '{provider}', to_jsonb(candidate.provider), true),
	version = settings.version + 1,
	updated_at = now()
FROM provider_candidates AS candidate
WHERE settings.organization_id = candidate.organization_id
	AND settings.namespace = 'context_tree'
	AND settings.value = candidate.source_value
	AND settings.version = candidate.source_version
	AND candidate.provider IS NOT NULL
	AND jsonb_typeof(settings.value) = 'object'
	AND jsonb_typeof(settings.value -> 'repo') = 'string'
	AND NOT settings.value ? 'provider';
