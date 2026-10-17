from .routes import paluwagan_bp


def init_paluwagan(app):
    """Initialize the Community Rotating Savings (Paluwagan) module.

    Registers a read-only blueprint. All financial actions are user-signed
    on-chain in the browser, so there is no server-side scheduler, no database
    and no privileged key for this feature.
    """
    try:
        app.register_blueprint(paluwagan_bp)
        import logging
        logging.getLogger(__name__).info("✅ Paluwagan (Community Savings) module initialized")
        return True
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"❌ Paluwagan initialization failed: {e}")
        return False


__all__ = ["paluwagan_bp", "init_paluwagan"]
