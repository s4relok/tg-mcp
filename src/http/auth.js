export function requireAppToken(config) {
  return (req, res, next) => {
    if (!config.appAuthToken) {
      next();
      return;
    }

    const expected = `Bearer ${config.appAuthToken}`;
    if (req.get('authorization') === expected) {
      next();
      return;
    }

    res.status(401).json({ error: 'unauthorized' });
  };
}
