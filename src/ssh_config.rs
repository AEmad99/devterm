//! Concrete `Host` names from an OpenSSH config. Wildcards are skipped, matching
//! DevTerm's SSH config import.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshHost {
    pub name: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
}

pub fn parse_ssh_config(text: &str) -> Vec<SshHost> {
    let mut hosts = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        if key.eq_ignore_ascii_case("host") {
            current.clear();
            for name in parts {
                if name.contains(['*', '?', '!']) {
                    continue;
                }
                hosts.push(SshHost {
                    name: name.to_string(),
                    host_name: None,
                    user: None,
                });
                current.push(hosts.len() - 1);
            }
        } else if key.eq_ignore_ascii_case("hostname") {
            if let Some(value) = parts.next() {
                for index in &current {
                    hosts[*index].host_name = Some(value.to_string());
                }
            }
        } else if key.eq_ignore_ascii_case("user") {
            if let Some(value) = parts.next() {
                for index in &current {
                    hosts[*index].user = Some(value.to_string());
                }
            }
        }
    }
    hosts
}

#[cfg(test)]
mod tests {
    use super::parse_ssh_config;

    #[test]
    fn keeps_concrete_hosts_and_their_user() {
        let hosts = parse_ssh_config(
            "\
Host *\n\
  User skipped\n\
Host devbox lab\n\
  HostName 10.0.0.8\n\
  User ada\n\
",
        );
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].name, "devbox");
        assert_eq!(hosts[0].host_name.as_deref(), Some("10.0.0.8"));
        assert_eq!(hosts[0].user.as_deref(), Some("ada"));
        assert_eq!(hosts[1].name, "lab");
        assert_eq!(hosts[1].user.as_deref(), Some("ada"));
    }
}
